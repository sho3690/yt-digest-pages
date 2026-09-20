/* YouTube Digest — 「チャンネルを管理」の画面に依存しない部分
   変更（追加・削除・停止・再開）をため込み、GitHub の Issue 本文に組み立てる。
   ブラウザでは window.YTD_MANAGE、Node では module.exports として使える（テスト用）。 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.YTD_MANAGE = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var OPS = { remove: "削除", disable: "停止", enable: "再開" };
  var ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

  function validateInput(v) {
    v = String(v == null ? "" : v).trim();
    if (!v) return "URL か @ハンドルを入力してください。";
    if (ID_RE.test(v)) return "";
    if (/^@?[A-Za-z0-9._-]{3,60}$/.test(v)) return "";
    if (/^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(v)) return "";
    return "YouTube のチャンネルURL、@ハンドル、または動画URLを入力してください。";
  }

  function empty() { return { adds: [], ops: {} }; }
  function clone(c) {
    var ops = {};
    Object.keys(c.ops).forEach(function (k) { ops[k] = c.ops[k]; });
    return { adds: c.adds.slice(), ops: ops };
  }
  function count(c) { return c.adds.length + Object.keys(c.ops).length; }

  function addRequest(c, value) {
    var v = String(value == null ? "" : value).trim();
    var error = validateInput(v);
    if (error) return { changes: c, error: error };
    var next = clone(c);
    if (next.adds.indexOf(v) < 0) next.adds.push(v);
    return { changes: next, error: "" };
  }
  function removeAdd(c, value) {
    var next = clone(c);
    next.adds = next.adds.filter(function (x) { return x !== value; });
    return next;
  }
  function setOp(c, id, op) {
    if (op != null && !OPS[op]) throw new Error("unknown op: " + op);
    var next = clone(c);
    if (op == null) delete next.ops[id];
    else next.ops[id] = op;
    return next;
  }

  function rows(registered, c) {
    return (registered || []).map(function (r) {
      return { id: r.id, name: r.name, enabled: !!r.enabled, count: r.count || 0, pending: c.ops[r.id] || null };
    });
  }

  function buildIssue(c, registered) {
    var names = {};
    (registered || []).forEach(function (r) { names[r.id] = r.name; });
    var lines = [], counts = { add: c.adds.length, remove: 0, disable: 0, enable: 0 };
    c.adds.forEach(function (v) { lines.push("add: " + v); });
    ["remove", "disable", "enable"].forEach(function (op) {
      Object.keys(c.ops).forEach(function (id) {
        if (c.ops[id] !== op) return;
        counts[op] += 1;
        lines.push(op + ": " + id + (names[id] ? " # " + names[id].replace(/[\r\n]+/g, " ") : ""));
      });
    });
    var parts = [];
    if (counts.add) parts.push("追加" + counts.add);
    if (counts.remove) parts.push("削除" + counts.remove);
    if (counts.disable) parts.push("停止" + counts.disable);
    if (counts.enable) parts.push("再開" + counts.enable);
    return {
      title: "チャンネル変更: " + parts.join("・"),
      body: lines.join("\n") + "\n\n（YouTube Digest の「チャンネルを管理」から送信）"
    };
  }

  function issueUrl(repo, label, issue) {
    return "https://github.com/" + repo + "/issues/new?labels=" + encodeURIComponent(label) +
      "&title=" + encodeURIComponent(issue.title) + "&body=" + encodeURIComponent(issue.body);
  }

  function resultLines(comment) {
    return String(comment == null ? "" : comment).split(/\r?\n/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s && s.indexOf("実行ログ:") !== 0; });
  }

  return {
    OPS: OPS, validateInput: validateInput, empty: empty, count: count, addRequest: addRequest,
    removeAdd: removeAdd, setOp: setOp, rows: rows, buildIssue: buildIssue, issueUrl: issueUrl,
    resultLines: resultLines
  };
});
