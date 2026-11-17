(function () {
  "use strict";
  const sides = {
    long: {text:"多头持仓",tone:"long",action:"做多"},
    short: {text:"空头持仓",tone:"short",action:"做空"}
  };

  function side(value) {
    return Object.hasOwn(sides, value) ? sides[value] : {text:"方向待核对",tone:"warning",action:"方向未知"};
  }

  function position(snapshot, online = true) {
    if (!snapshot || snapshot.native && !snapshot.updatedAt) return {text:"持仓待同步",tone:"warning"};
    const positions = snapshot.native ? snapshot.positions ?? [] : snapshot.position ? [snapshot.position] : [];
    const directions = new Set(positions.map(item => item.side));
    let current = {text:"当前空仓",tone:"flat"};
    if (directions.size === 1) current = side([...directions][0]);
    else if (directions.size > 1) current = directions.has("long") && directions.has("short")
      ? {text:"多空同时持仓",tone:"dual"}
      : {text:"持仓方向待核对",tone:"warning"};
    return online ? current : {text:"上次 · " + current.text,tone:"warning"};
  }

  function badge(element, text, tone) {
    if (element.textContent !== text) element.textContent = text;
    element.classList.add("trade-badge");
    element.dataset.tone = tone;
  }

  window.JustTradeLabels = {badge, position, side};
})();
