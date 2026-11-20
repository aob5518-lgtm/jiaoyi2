(function () {
  "use strict";
  let activeDialog = null;
  let checkingNavigation = false;

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function show({title, message, content, action = "确认", cancel = "取消", danger = false, info = false}) {
    if (activeDialog) return Promise.resolve(false);
    const dialog = node("dialog", "", "site-dialog");
    const header = node("h2", title);
    header.id = "site-dialog-title";
    dialog.setAttribute("aria-labelledby", header.id);
    dialog.append(header);
    if (message) dialog.append(node("p", message, "site-dialog-message"));
    if (content) dialog.append(content);
    const buttons = node("div", "", "site-dialog-actions");
    const cancelButton = node("button", cancel);
    cancelButton.type = "button";
    cancelButton.dataset.siteCancel = "";
    const accept = node("button", info ? "关闭" : action, danger ? "exit-button" : "primary");
    accept.type = "button";
    accept.dataset.siteAccept = "";
    if (!info) buttons.append(cancelButton);
    buttons.append(accept);
    dialog.append(buttons);
    document.body.append(dialog);
    activeDialog = dialog;
    return new Promise(resolve => {
      dialog.addEventListener("close", () => {
        const confirmed = dialog.returnValue === "accept";
        dialog.remove();
        activeDialog = null;
        resolve(confirmed);
      }, {once:true});
      cancelButton.onclick = () => dialog.close("cancel");
      accept.onclick = () => dialog.close("accept");
      dialog.showModal();
      (info ? accept : cancelButton).focus();
    });
  }

  async function guard(type, detail) {
    if (checkingNavigation || activeDialog) return false;
    checkingNavigation = true;
    try {
      const checks = [], after = [];
      const event = new CustomEvent(type, {detail, cancelable:true});
      event.check = check => checks.push(check);
      event.onAllowed = apply => after.push(apply);
      if (!document.dispatchEvent(event)) return false;
      for (const check of checks) if (!await check()) return false;
      for (const apply of after) apply();
      return true;
    } finally {
      checkingNavigation = false;
    }
  }

  window.JustDialogs = {show, guard, discard: message => show({title:"放弃未保存修改？", message, action:"放弃修改"})};
})();
