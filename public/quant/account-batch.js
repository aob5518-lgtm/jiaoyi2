(function () {
  "use strict";
  const $ = id => document.getElementById(id);
  const node = (tag, value) => {
    const element = document.createElement(tag);
    element.textContent = value;
    return element;
  };

  async function checkEach(rows, operation, progress) {
    let next = 0, done = 0;
    const results = [];
    async function worker() {
      while (next < rows.length) {
        const index = next++;
        const account = rows[index];
        try {results[index] = {account, ...await operation(account)};}
        catch (error) {results[index] = {account, reason:error.message};}
        progress(++done);
      }
    }
    await Promise.all(Array.from({length:Math.min(3, rows.length)}, worker));
    return results;
  }

  function resultList(rows, successLabel) {
    const list = node("ul", "");
    list.className = "batch-results";
    for (const {account, reason} of rows) {
      const item = node("li", "");
      item.append(node("strong", account.name), node("small", reason || successLabel));
      list.append(item);
    }
    return list;
  }

  function mount({request, canOpen, onChanged}) {
    const dialog = $("accountBatch");
    if (!dialog) return;
    const search = $("batchSearch"), scope = $("batchScope"), mode = $("batchMode"), selectAll = $("batchSelectAll");
    const close = $("batchClose"), apply = $("batchApply"), list = $("batchAccounts"), summary = $("batchSummary");
    const selected = new Set();
    let accounts = [], visible = [], busy = false;
    const restoring = () => scope.value === "archived";

    function selection() {
      const count = visible.filter(account => selected.has(account.id)).length;
      selectAll.checked = count > 0 && count === visible.length;
      selectAll.indeterminate = count > 0 && count < visible.length;
      selectAll.disabled = busy || !visible.length;
      apply.disabled = busy || !count;
      summary.textContent = "已选 " + count + " 项 · 当前显示 " + visible.length + " 个账户";
    }

    function render() {
      const term = search.value.trim().toLowerCase();
      visible = accounts.filter(account => {
        if (!!account.archivedAt !== restoring()) return false;
        const type = account.tradeMode === "live" ? "live" : "paper";
        if (mode.value !== "all" && mode.value !== type) return false;
        return [account.name, account.platform, account.symbol, account.quoteAsset].join(" ").toLowerCase().includes(term);
      });
      const ids = new Set(visible.map(account => account.id));
      for (const id of selected) if (!ids.has(id)) selected.delete(id);
      list.replaceChildren(...visible.map(account => {
        const row = node("label", "");
        row.className = "batch-row";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = selected.has(account.id);
        box.disabled = busy;
        box.onchange = () => {if (box.checked) selected.add(account.id); else selected.delete(account.id);selection();};
        const title = node("span", "");
        title.title = account.name;
        title.append(node("strong", account.name), node("small", [
          account.platform, account.symbol + "/" + account.quoteAsset,
          account.tradeMode === "live" ? "真实连接" : "模拟",
          account.archivedAt ? "已删除" : account.running ? "运行中" : "已停止"
        ].join(" · ")));
        row.append(box, title);
        return row;
      }));
      if (!visible.length) list.append(node("p", "没有匹配的账户"));
      search.disabled = scope.disabled = mode.disabled = close.disabled = busy;
      apply.className = restoring() ? "primary" : "exit-button";
      apply.textContent = restoring() ? "批量恢复" : "核对并删除";
      selection();
    }

    async function refresh() {
      accounts = (await request("/api/v4/connections")).accounts;
      render();
    }

    $("openAccountBatch").onclick = async () => {
      if (busy || dialog.open || !await canOpen()) return;
      selected.clear();
      accounts = [];
      search.value = "";
      scope.value = "active";
      mode.value = "all";
      busy = true;
      dialog.showModal();
      render();
      summary.textContent = "正在读取账户列表…";
      try {await refresh();}
      catch (error) {
        await JustDialogs.show({title:"账户列表读取失败", message:error.message, info:true});
        dialog.close();
      } finally {busy = false;render();search.focus();}
    };

    search.oninput = mode.onchange = render;
    scope.onchange = () => {selected.clear();render();};
    selectAll.onchange = () => {
      const checked = selectAll.checked;
      for (const account of visible) if (checked) selected.add(account.id); else selected.delete(account.id);
      render();
    };
    close.onclick = () => dialog.close();
    dialog.addEventListener("cancel", event => {if (busy) event.preventDefault();});

    apply.onclick = async () => {
      if (busy || !selected.size) return;
      const action = restoring() ? "restore" : "archive";
      const operation = restoring() ? "恢复" : "删除";
      const picked = visible.filter(account => selected.has(account.id));
      busy = true;
      render();
      try {
        const reviewed = action === "restore"
          ? picked.map(account => ({account,version:account.lifecycleVersion}))
          : await checkEach(picked, async account => {
            const {review} = await request("/api/v4/connections/archive-preview", {id:account.id});
            return review.allowed ? {version:review.version} : {reason:review.blockers.map(blocker => blocker.message).join("；")};
          }, count => {summary.textContent = "核对中 " + count + " / " + picked.length;});
        const approved = reviewed.filter(item => item.version && !item.reason);
        if (!await JustDialogs.show({
          title:approved.length ? "确认批量" + operation : "所选账户暂不能删除",
          message:approved.length
            ? "可" + operation + " " + approved.length + " 个，跳过 " + (reviewed.length - approved.length) + " 个。历史和账本保留，可在「已删除」恢复；恢复后不会自动启动。"
            : "请查看下方原因。",
          content:resultList(reviewed, "可" + operation), action:operation + " " + approved.length + " 个账户",
          danger:action === "archive", info:!approved.length
        }) || !approved.length) return;
        const results = await checkEach(approved.map(item => ({...item.account, lifecycleVersion:item.version})), async account => {
          await request("/api/v4/connections/" + action, {id:account.id,confirm:true,expectedVersion:account.lifecycleVersion});
          return {};
        }, count => {summary.textContent = operation + "进度 " + count + " / " + approved.length;});
        const completed = results.filter(result => !result.reason);
        for (const {account} of completed) selected.delete(account.id);
        let refreshNote = "";
        try {await refresh();await onChanged();}
        catch {refreshNote = " 账户列表刷新失败，关闭后重新打开可查看最新状态。";}
        await JustDialogs.show({title:"批量" + operation + "结果", info:true,
          message:"已" + operation + " " + completed.length + " 个，未处理 " + (reviewed.length - completed.length) + " 个。" + refreshNote,
          content:resultList([...results, ...reviewed.filter(item => item.reason)], "已" + operation)});
      } finally {busy = false;render();}
    };
  }

  window.JustAccountBatch = {mount};
})();
