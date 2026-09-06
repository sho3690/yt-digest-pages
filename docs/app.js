/* YouTube Digest — 閲覧アプリ本体
   data.json（ビルド済み・本文HTMLはエスケープ済み）を読み、2種類の読み物を3ペインで表示する。
     週のまとめ … weeks（1週 = 1本）
     動画       … videos（1動画 = 1本。要約が無いものは状態だけ）
   既読・スター・表示モードは端末内（localStorage）だけに保存する。 */
(function () {
  "use strict";

  var KEYS = { read: "ytd-read", star: "ytd-star", theme: "ytd-theme", mode: "ytd-mode", filter: "ytd-filter" };
  var STALE_DAYS = 9;      // 週1回の更新がこれ以上止まっていたら知らせる
  var MOBILE = "(max-width: 960px)";

  var state = {
    data: null, weeks: [], videos: [], byKey: {}, weekById: {},
    mode: "weeks", filter: "all", query: "", selected: null, visible: [],
    read: new Set(), star: new Set(), theme: "system"
  };
  var el = {};

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function stripTags(s) { return String(s).replace(/<[^>]+>/g, ""); }
  function isMobile() { return window.matchMedia(MOBILE).matches; }
  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric" });
  }

  // ---------- 保存 ----------
  function loadSet(key) {
    try { return new Set(JSON.parse(localStorage.getItem(key) || "[]")); } catch (e) { return new Set(); }
  }
  function saveSet(key, set) {
    try { localStorage.setItem(key, JSON.stringify(Array.from(set))); } catch (e) { /* 保存できなくても動く */ }
  }
  function loadStr(key, fallback) {
    try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; }
  }
  function saveStr(key, v) { try { localStorage.setItem(key, v); } catch (e) { /* noop */ } }

  // ---------- 起動 ----------
  function boot() {
    ["sidebar", "list", "reader", "scrim", "mode-seg", "seg-weeks", "seg-videos", "nav-primary", "nav-weeks",
     "nav-channels", "nav-channels-group", "notice-stale", "built-at", "theme-toggle", "theme-label", "menu-btn",
     "drawer-close", "list-title", "list-count", "mark-all", "search", "list-scroll", "reader-back", "prev-btn",
     "next-btn", "reader-pos", "star-btn", "read-btn", "reader-scroll", "reader-empty", "reader-content",
     "empty-stats", "add-channel", "channel-dialog", "channel-form", "channel-input", "channel-error", "channel-cancel",
     "push-box", "push-status", "push-btn", "push-link"]
      .forEach(function (id) {
        el[id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] = document.getElementById(id);
      });

    state.read = loadSet(KEYS.read);
    state.star = loadSet(KEYS.star);
    state.theme = loadStr(KEYS.theme, "system");
    applyTheme();

    fetch("./data.json?v=" + encodeURIComponent(window.YTD_BUILD || Date.now()), { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(init)
      .catch(function (e) {
        el.listScroll.innerHTML = '<div class="list__empty">データを読み込めませんでした。<br>通信状態を確認して、再読み込みしてください。<br><small>' + esc(e.message) + "</small></div>";
      });
  }

  function init(data) {
    state.data = data;
    data.weeks.forEach(function (w) { state.weekById[w.id] = w; });

    state.weeks = data.weeks.map(function (w) {
      var text = [w.label, w.headline || "", stripTags(w.overview.join(" ")), stripTags(w.flow || "")]
        .concat(w.sections.map(function (s) { return s.title + " " + stripTags(s.html.join(" ")); }), w.channels,
          (w.takeaways || []).map(stripTags),
          (w.themes || []).map(function (t) { return [t.why_now, t.so_what, t.agreement, t.disagreement].concat(t.facts, t.views.map(function (v) { return v.who + " " + v.says; })).map(stripTags).join(" "); }),
          (w.others || []).map(function (o) { return stripTags(o.one_line); }))
        .join(" ").toLowerCase();
      return { key: "w:" + w.id, kind: "week", id: w.id, week: w.id, data: w, _text: text };
    });
    state.videos = data.videos.map(function (v) {
      var text = [v.title, v.channel, stripTags(v.summary), stripTags(v.flow || "")]
        .concat(v.points.map(stripTags), (v.takeaways || []).map(stripTags), v.sections,
          (v.outline || []).map(function (o) { return o.heading + " " + stripTags(o.summary) + " " + o.details.map(stripTags).join(" "); }),
          (v.glossary || []).map(function (g) { return g.term + " " + stripTags(g.plain); }))
        .join(" ").toLowerCase();
      return { key: "v:" + v.id, kind: "video", id: v.id, week: v.week, data: v, _text: text };
    });
    state.weeks.concat(state.videos).forEach(function (e) { state.byKey[e.key] = e; });

    // 既読・スターは存在するものだけ残す（古い形式のIDも捨てる）
    state.read = new Set(Array.from(state.read).filter(function (k) { return state.byKey[k]; }));
    state.star = new Set(Array.from(state.star).filter(function (k) { return state.byKey[k]; }));

    var m = loadStr(KEYS.mode, "weeks");
    state.mode = m === "videos" ? "videos" : "weeks";
    var f = loadStr(KEYS.filter, "all");
    if (isValidFilter(f)) state.filter = f;

    bindEvents();
    renderAll();
    renderReader(null);
    renderFoot();
    applyHash();
    setupPush();
  }

  function isValidFilter(f) {
    if (f === "all" || f === "unread" || f === "starred") return true;
    if (f.indexOf("week:") === 0) return !!state.weekById[f.slice(5)];
    if (f.indexOf("channel:") === 0) return state.data.channels.some(function (c) { return c.name === f.slice(8); });
    return false;
  }

  // ---------- テーマ ----------
  function applyTheme() {
    var root = document.documentElement;
    if (state.theme === "light" || state.theme === "dark") root.dataset.theme = state.theme;
    else delete root.dataset.theme;
    if (el.themeLabel) el.themeLabel.textContent = "表示: " + ({ system: "システム", light: "ライト", dark: "ダーク" })[state.theme];
  }
  function cycleTheme() {
    state.theme = ({ system: "light", light: "dark", dark: "system" })[state.theme] || "system";
    saveStr(KEYS.theme, state.theme);
    applyTheme();
  }

  // ---------- 絞り込み ----------
  function pool() { return state.mode === "videos" ? state.videos : state.weeks; }

  function matches(e, filter) {
    var f = filter == null ? state.filter : filter;
    if (f === "unread" && state.read.has(e.key) && e.key !== state.selected) return false;
    if (f === "starred" && !state.star.has(e.key)) return false;
    if (f.indexOf("week:") === 0 && e.week !== f.slice(5)) return false;
    if (f.indexOf("channel:") === 0) {
      var ch = f.slice(8);
      if (e.kind === "video" ? e.data.channel !== ch : e.data.channels.indexOf(ch) < 0) return false;
    }
    var q = state.query.trim().toLowerCase();
    if (q) {
      var terms = q.split(/\s+/);
      for (var i = 0; i < terms.length; i++) if (e._text.indexOf(terms[i]) < 0) return false;
    }
    return true;
  }
  function computeVisible() { state.visible = pool().filter(function (e) { return matches(e); }); }

  function unreadIn(list, pred) {
    var n = 0;
    list.forEach(function (e) { if (!state.read.has(e.key) && (!pred || pred(e))) n++; });
    return n;
  }

  function listTitle() {
    var f = state.filter, base = state.mode === "videos" ? "動画" : "週のまとめ";
    if (f === "all") return base;
    if (f === "unread") return "未読の" + base;
    if (f === "starred") return "スター付きの" + base;
    if (f.indexOf("week:") === 0) { var w = state.weekById[f.slice(5)]; return (w ? w.label : f.slice(5)) + " の週"; }
    if (f.indexOf("channel:") === 0) return f.slice(8);
    return base;
  }

  // ---------- ナビ ----------
  function navItem(filter, name, count, extra) {
    var active = state.filter === filter ? " is-active" : "";
    return '<button type="button" class="nav__item' + active + '" data-filter="' + esc(filter) + '">' +
      (extra == null ? '<span class="nav__dot"></span>' : extra) +
      '<span class="nav__name">' + esc(name) + "</span>" +
      (count == null ? "" : '<span class="nav__count' + (count.unread ? " has-unread" : "") + '">' + esc(count.text) + "</span>") +
      "</button>";
  }

  function renderNav() {
    var list = pool();
    var total = list.length, unread = unreadIn(list), starred = list.filter(function (e) { return state.star.has(e.key); }).length;

    el.segWeeks.textContent = unreadIn(state.weeks) || "";
    el.segVideos.textContent = unreadIn(state.videos) || "";
    Array.prototype.forEach.call(el.modeSeg.querySelectorAll("[data-mode]"), function (b) {
      var on = b.dataset.mode === state.mode;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });

    el.navPrimary.innerHTML =
      navItem("all", "すべて", { text: unread ? unread + " / " + total : total, unread: unread }, "") +
      navItem("unread", "未読", { text: unread, unread: unread }, "") +
      navItem("starred", "スター", { text: starred }, "");

    el.navWeeks.innerHTML = state.data.weeks.map(function (w, i) {
      var inWeek = list.filter(function (e) { return e.week === w.id; });
      var u = unreadIn(inWeek);
      var latest = i === 0 ? '<span class="nav__latest">最新</span>' : "";
      var text = state.mode === "videos" ? (u ? u + " / " + inWeek.length : inWeek.length) : (u ? "未読" : "");
      return navItem("week:" + w.id, w.label, { text: text, unread: u }, latest);
    }).join("");

    el.navChannelsGroup.hidden = state.mode !== "videos";
    el.navChannels.innerHTML = state.data.channels.map(function (c) {
      var u = unreadIn(state.videos, function (e) { return e.data.channel === c.name; });
      if (!c.count) return navItem("channel:" + c.name, c.name, { text: "登録済み", unread: 0 });
      return navItem("channel:" + c.name, c.name, { text: u ? u + " / " + c.count : c.count, unread: u });
    }).join("");
    el.addChannel.hidden = !(state.data.app && state.data.app.request_repo);
  }

  // ---------- 一覧 ----------
  function statusBadge(v) {
    if (v.status === "unavailable") return '<span class="badge">非公開</span>';
    if (v.status === "no_subtitle") return '<span class="badge badge--warn">字幕なし</span>';
    if (v.status === "pending") return '<span class="badge">要約はまだ</span>';
    return "";
  }

  function weekRowHtml(e) {
    var w = e.data;
    var cls = "row row--week" + (state.read.has(e.key) ? "" : " is-unread") + (e.key === state.selected ? " is-selected" : "");
    var star = state.star.has(e.key) ? '<svg class="row__star"><use href="#i-star-fill"/></svg>' : "";
    var thumbs = w.thumbs.length
      ? '<span class="row__mosaic">' + w.thumbs.slice(0, 4).map(function (t) {
          return '<span style="background-image:url(&quot;' + esc(t) + '&quot;)"></span>';
        }).join("") + "</span>"
      : '<span class="row__thumb row__thumb--empty"><svg><use href="#i-play"/></svg></span>';
    var meta = 'テーマ' + w.sections.length + " · 動画" + w.video_count + "本" +
      (w.summarized ? "（要約" + w.summarized + "本）" : "");
    var title = w.headline ? w.headline : w.label + " の週";
    var chan = w.headline ? esc(w.label) + " · " + esc(meta) : esc(w.date.slice(0, 4)) + "年 · " + esc(meta);
    return '<button type="button" class="' + cls + '" data-key="' + esc(e.key) + '">' +
      '<span class="row__main">' +
        '<span class="row__meta">' + star + '<span class="row__chan">' + chan + "</span></span>" +
        '<span class="row__title row__title--serif">' + esc(title) + "</span>" +
        (w.excerpt ? '<span class="row__excerpt">' + esc(w.excerpt) + "</span>" : "") +
      "</span>" + thumbs + "</button>";
  }

  function videoRowHtml(e) {
    var v = e.data;
    var cls = "row" + (state.read.has(e.key) ? "" : " is-unread") + (e.key === state.selected ? " is-selected" : "");
    var star = state.star.has(e.key) ? '<svg class="row__star"><use href="#i-star-fill"/></svg>' : "";
    var date = fmtDate(v.published);
    var thumb = v.thumb
      ? '<span class="row__thumb" style="background-image:url(&quot;' + esc(v.thumb) + '&quot;)"></span>'
      : '<span class="row__thumb row__thumb--empty"><svg><use href="#i-play"/></svg></span>';
    var excerpt = v.excerpt || (v.status === "pending" ? "要約はまだ作られていません。" :
      v.status === "no_subtitle" ? "字幕が取得できなかったため、要約はありません。" :
      v.status === "unavailable" ? "この動画は非公開または削除されています。" : "");
    return '<button type="button" class="' + cls + '" data-key="' + esc(e.key) + '">' +
      '<span class="row__main">' +
        '<span class="row__meta">' + statusBadge(v) + star + '<span class="row__chan">' + esc(v.channel) + (date ? " · " + date : "") + "</span></span>" +
        '<span class="row__title">' + esc(v.title) + "</span>" +
        (excerpt ? '<span class="row__excerpt">' + esc(excerpt) + "</span>" : "") +
      "</span>" + thumb + "</button>";
  }

  function rowHtml(e) { return e.kind === "week" ? weekRowHtml(e) : videoRowHtml(e); }

  function renderList() {
    computeVisible();
    el.listTitle.textContent = listTitle();
    renderListCountOnly();

    if (!state.visible.length) {
      var msg = state.query ? "「" + esc(state.query) + "」に一致するものはありません。" :
        state.filter === "unread" ? "未読はありません。<br>今週もお疲れさまでした。" :
        state.filter === "starred" ? "スターを付けたものはここに集まります。" : "まだありません。";
      el.listScroll.innerHTML = '<div class="list__empty">' + msg + "</div>";
      return;
    }

    var html = [], lastWeek = null;
    state.visible.forEach(function (e) {
      if (state.mode === "videos" && e.week !== lastWeek) {
        lastWeek = e.week;
        var w = state.weekById[e.week] || { label: e.week, date: e.week };
        var inWeek = state.visible.filter(function (x) { return x.week === e.week; });
        var uw = unreadIn(inWeek);
        html.push('<div class="group"><span class="group__label">' + esc(w.label) +
          "<small>" + esc(w.date.slice(0, 4)) + "</small></span>" +
          '<span class="group__count">' + inWeek.length + "本" + (uw ? " · 未読" + uw : "") + "</span></div>");
      }
      html.push(rowHtml(e));
    });
    el.listScroll.innerHTML = html.join("");
  }

  function renderListCountOnly() {
    var u = unreadIn(state.visible);
    el.listCount.textContent = state.visible.length ? state.visible.length + "本" + (u ? " · 未読" + u : "") : "";
    el.markAll.disabled = !u;
  }

  function refreshRow(key) {
    var btn = el.listScroll.querySelector('[data-key="' + CSS.escape(key) + '"]');
    var e = state.byKey[key];
    if (!btn || !e) return;
    var tmp = document.createElement("div");
    tmp.innerHTML = rowHtml(e);
    btn.replaceWith(tmp.firstChild);
  }

  // ---------- 本文 ----------
  function videoChipHtml(vid) {
    var e = state.byKey["v:" + vid];
    if (!e) return "";
    var v = e.data;
    var thumb = v.thumb ? '<span class="vchip__thumb" style="background-image:url(&quot;' + esc(v.thumb) + '&quot;)"></span>'
                        : '<span class="vchip__thumb vchip__thumb--empty"></span>';
    return '<button type="button" class="vchip" data-goto="' + esc(e.key) + '">' + thumb +
      '<span class="vchip__body"><span class="vchip__chan">' + esc(v.channel) + "</span>" +
      '<span class="vchip__title">' + esc(v.title) + "</span></span></button>";
  }

  function themeHtml(t, i) {
    var parts = ['<section class="theme">'];
    parts.push('<div class="theme__head"><span class="outline__no">' + (i + 1) + '</span><h2 class="theme__title">' + esc(t.title) + "</h2></div>");
    if (t.why_now) parts.push('<p class="theme__why"><span class="tag">位置づけ</span>' + t.why_now + "</p>");
    parts.push('<p class="theme__summary">' + t.summary + "</p>");
    if (t.views.length) {
      parts.push('<div class="views">' + t.views.map(function (v) {
        return '<div class="view"><span class="view__who">' + esc(v.who) + '</span><span class="view__says">' + v.says + "</span></div>";
      }).join("") + "</div>");
    }
    if (t.agreement) parts.push('<p class="theme__line"><span class="tag tag--ok">一致</span>' + t.agreement + "</p>");
    if (t.disagreement) parts.push('<p class="theme__line"><span class="tag tag--warn">相違</span>' + t.disagreement + "</p>");
    if (t.facts.length) parts.push('<ul class="outline__details theme__facts">' + t.facts.map(function (f) { return "<li>" + f + "</li>"; }).join("") + "</ul>");
    if (t.change) parts.push('<p class="theme__line"><span class="tag">変化</span>' + t.change + "</p>");
    if (t.so_what) parts.push('<div class="sowhat"><span class="sowhat__label">示唆</span><p>' + t.so_what + "</p></div>");
    if (t.video_ids.length) parts.push('<div class="vchips">' + t.video_ids.map(videoChipHtml).join("") + "</div>");
    parts.push("</section>");
    return parts.join("");
  }

  function weekReaderHtml(e) {
    var w = e.data, parts = [];
    if (w.themes && w.themes.length) return weekReaderHtmlV2(e);
    parts.push('<p class="kicker"><span class="kicker__week">週のまとめ</span><span class="kicker__sep">·</span><span>' +
      esc(w.date.slice(0, 4)) + "年</span></p>");
    parts.push('<h1 class="headline">' + esc(w.label) + " の週</h1>");
    parts.push('<p class="subline">テーマ ' + w.sections.length + " · 動画 " + w.video_count + "本" +
      (w.summarized ? "（要約 " + w.summarized + "本）" : "") + " · " + esc(w.channels.slice(0, 4).join(" / ")) +
      (w.channels.length > 4 ? " ほか" : "") + "</p>");
    if (w.warnings.length) {
      parts.push('<div class="warnings">' + w.warnings.map(function (x) {
        return '<div class="notice notice--warn">' + esc(x) + "</div>";
      }).join("") + "</div>");
    }
    if (w.overview.length) {
      parts.push('<div class="body body--lead">' + w.overview.map(function (p) { return "<p>" + p + "</p>"; }).join("") + "</div>");
    }
    w.sections.forEach(function (s, i) {
      parts.push('<section class="topic"><h2 class="topic__title"><span class="topic__no">' + (i + 1) + "</span>" + esc(s.title) + "</h2>" +
        '<div class="body">' + s.html.map(function (p) { return "<p>" + p + "</p>"; }).join("") + "</div>" +
        (s.video_ids.length ? '<div class="vchips">' + s.video_ids.map(videoChipHtml).join("") + "</div>" : "") +
        "</section>");
    });
    parts.push('<div class="reader__cta">' +
      '<button type="button" class="textbtn" data-videos-of="' + esc(w.id) + '"><svg><use href="#i-play"/></svg><span>この週の動画 ' + w.video_count + "本を見る</span></button></div>");
    parts.push(footNav(e));
    return parts.join("");
  }

  function videoReaderHtml(e) {
    var v = e.data, w = state.weekById[v.week], parts = [];
    var hero = v.thumb
      ? '<a class="hero" href="' + esc(v.url) + '" target="_blank" rel="noopener noreferrer" aria-label="YouTubeで見る">' +
        '<img class="hero__img" src="' + esc(v.thumb.replace("mqdefault", "hqdefault")) + '" alt="" loading="lazy">' +
        '<span class="hero__play"><svg><use href="#i-play"/></svg></span></a>'
      : '<div class="hero hero--empty"><svg><use href="#i-play"/></svg></div>';
    parts.push(hero);
    var date = fmtDate(v.published);
    parts.push('<p class="kicker"><span class="kicker__week">' + esc(v.channel) + "</span>" +
      (date ? '<span class="kicker__sep">·</span><span>' + date + "公開</span>" : "") +
      (w ? '<span class="kicker__sep">·</span><span>' + esc(w.label) + " の週</span>" : "") + "</p>");
    parts.push('<h1 class="headline headline--video">' + esc(v.title) + "</h1>");
    if (v.status === "ok" && v.outline && v.outline.length) {
      // 骨格つきの要約: 結論 → 骨格 → つながり → 持ち帰り → 用語
      parts.push('<div class="body body--lead"><p>' + v.summary + "</p></div>");
      parts.push('<section class="skeleton"><h2 class="sources__title">動画の骨格 <span class="n">' + v.outline.length + "</span></h2>" +
        '<ol class="outline">' + v.outline.map(function (sec, i) {
          return '<li class="outline__item">' +
            '<div class="outline__head"><span class="outline__no">' + (i + 1) + "</span>" +
              (sec.role ? '<span class="outline__role">' + esc(sec.role) + "</span>" : "") +
              '<h3 class="outline__title">' + esc(sec.heading) + "</h3></div>" +
            '<p class="outline__summary">' + sec.summary + "</p>" +
            (sec.details.length ? '<ul class="outline__details">' + sec.details.map(function (d) { return "<li>" + d + "</li>"; }).join("") + "</ul>" : "") +
            "</li>";
        }).join("") + "</ol></section>");
      if (v.flow) parts.push('<section class="flowbox"><h2 class="sources__title">話のつながり</h2><p>' + v.flow + "</p></section>");
      if (v.takeaways.length) {
        parts.push('<section class="skeleton"><h2 class="sources__title">持ち帰るポイント <span class="n">' + v.takeaways.length + '</span></h2><ul class="points">' +
          v.takeaways.map(function (p) { return "<li>" + p + "</li>"; }).join("") + "</ul></section>");
      }
      if (v.glossary.length) {
        parts.push('<section class="skeleton"><h2 class="sources__title">用語をやさしく</h2><dl class="glossary">' +
          v.glossary.map(function (g) { return "<div><dt>" + esc(g.term) + "</dt><dd>" + g.plain + "</dd></div>"; }).join("") + "</dl></section>");
      }
      if (v.note) parts.push('<p class="note">※ ' + esc(v.note) + "</p>");
    } else if (v.status === "ok") {
      // 古い型の要約（要点の箇条書きだけ）
      parts.push('<div class="body"><p>' + v.summary + "</p></div>");
      if (v.points.length) {
        parts.push('<ul class="points">' + v.points.map(function (p) { return "<li>" + p + "</li>"; }).join("") + "</ul>");
      }
      parts.push('<p class="note">※ この要約は旧形式です。次の更新で骨格つきの要約に置き換わります。</p>');
      if (v.note) parts.push('<p class="note">※ ' + esc(v.note) + "</p>");
    } else {
      var msg = v.status === "unavailable" ? "この動画は非公開または削除されています。" :
        v.status === "no_subtitle" ? "字幕が取得できなかったため、要約はありません。" :
        "要約はまだ作られていません。次回の自動実行で追加されます。";
      parts.push('<div class="notice notice--muted">' + msg + "</div>");
      if (v.note) parts.push('<p class="note">※ ' + esc(v.note) + "</p>");
    }
    parts.push('<div class="reader__cta"><a class="textbtn textbtn--primary" href="' + esc(v.url) + '" target="_blank" rel="noopener noreferrer"><svg><use href="#i-ext"/></svg><span>YouTubeで見る</span></a></div>');
    if (w) {
      parts.push('<section class="sources"><h2 class="sources__title">この動画が出てくる週のまとめ</h2>' +
        '<ol class="toclist"><li><button type="button" data-goto="w:' + esc(w.id) + '"><span class="no">週</span><span>' +
        esc(w.label) + " の週" + (v.sections.length ? '<span class="toclist__sub">' + esc(v.sections.join(" / ")) + "</span>" : "") +
        "</span></button></li></ol></section>");
    }
    parts.push(footNav(e));
    return parts.join("");
  }

  function weekReaderHtmlV2(e) {
    var w = e.data, parts = [];
    parts.push('<p class="kicker"><span class="kicker__week">週のまとめ</span><span class="kicker__sep">·</span><span>' +
      esc(w.label) + " · " + esc(w.date.slice(0, 4)) + "年</span></p>");
    parts.push('<h1 class="headline">' + esc(w.headline || (w.label + " の週")) + "</h1>");
    parts.push('<p class="subline">テーマ ' + w.themes.length + " · 動画 " + w.video_count + "本" +
      (w.summarized ? "（要約 " + w.summarized + "本）" : "") + " · " + esc(w.channels.slice(0, 4).join(" / ")) +
      (w.channels.length > 4 ? " ほか" : "") + "</p>");
    if (w.warnings.length) {
      parts.push('<div class="warnings">' + w.warnings.map(function (x) { return '<div class="notice notice--warn">' + esc(x) + "</div>"; }).join("") + "</div>");
    }
    parts.push('<div class="body body--lead">' + w.overview.map(function (p) { return "<p>" + p + "</p>"; }).join("") + "</div>");
    if (w.flow) parts.push('<section class="flowbox"><h2 class="sources__title">今週の骨格</h2><p>' + w.flow + "</p></section>");
    parts.push('<section class="skeleton"><h2 class="sources__title">テーマ <span class="n">' + w.themes.length + "</span></h2>" +
      w.themes.map(themeHtml).join("") + "</section>");
    if (w.watch_first && state.byKey["v:" + w.watch_first.video_id]) {
      var v = state.byKey["v:" + w.watch_first.video_id].data;
      parts.push('<section class="skeleton"><h2 class="sources__title">今週の一本</h2>' +
        '<button type="button" class="pick" data-goto="v:' + esc(v.id) + '">' +
          (v.thumb ? '<span class="pick__thumb" style="background-image:url(&quot;' + esc(v.thumb) + '&quot;)"></span>' : "") +
          '<span class="pick__body"><span class="vchip__chan">' + esc(v.channel) + '</span><span class="pick__title">' + esc(v.title) + "</span>" +
          '<span class="pick__reason">' + w.watch_first.reason + "</span></span></button></section>");
    }
    if (w.others.length) {
      parts.push('<section class="skeleton"><h2 class="sources__title">その他の動き <span class="n">' + w.others.length + '</span></h2><div class="others">' +
        w.others.map(function (o) {
          var ve = state.byKey["v:" + o.video_id];
          if (!ve) return "";
          return '<button type="button" class="other" data-goto="' + esc(ve.key) + '">' +
            '<span class="other__who">' + esc(ve.data.channel) + '</span><span class="other__line">' + o.one_line + "</span></button>";
        }).join("") + "</div></section>");
    }
    if (w.takeaways.length) {
      parts.push('<section class="skeleton"><h2 class="sources__title">今週の持ち帰り <span class="n">' + w.takeaways.length + '</span></h2><ul class="points">' +
        w.takeaways.map(function (p) { return "<li>" + p + "</li>"; }).join("") + "</ul></section>");
    }
    if (w.glossary.length) {
      parts.push('<section class="skeleton"><h2 class="sources__title">用語をやさしく</h2><dl class="glossary">' +
        w.glossary.map(function (g) { return "<div><dt>" + esc(g.term) + "</dt><dd>" + g.plain + "</dd></div>"; }).join("") + "</dl></section>");
    }
    parts.push('<div class="reader__cta"><button type="button" class="textbtn" data-videos-of="' + esc(w.id) + '"><svg><use href="#i-play"/></svg><span>この週の動画 ' + w.video_count + "本を見る</span></button></div>");
    parts.push(footNav(e));
    return parts.join("");
  }

  function footNav(e) {
    var idx = state.visible.indexOf(e);
    var prev = idx > 0 ? state.visible[idx - 1] : null;
    var next = idx >= 0 && idx < state.visible.length - 1 ? state.visible[idx + 1] : null;
    return '<div class="reader__foot">' +
      (prev ? '<button type="button" class="textbtn" data-goto="' + esc(prev.key) + '"><svg><use href="#i-up"/></svg><span>前へ</span></button>' : "<span></span>") +
      (next ? '<button type="button" class="textbtn" data-goto="' + esc(next.key) + '"><span>次へ</span><svg><use href="#i-down"/></svg></button>' : "<span></span>") +
      "</div>";
  }

  function renderReader(e) {
    if (!e) {
      el.readerEmpty.hidden = false;
      el.readerContent.hidden = true;
      el.readerContent.innerHTML = "";
      el.readerPos.textContent = "";
      el.starBtn.disabled = true; el.readBtn.disabled = true;
      el.prevBtn.disabled = true; el.nextBtn.disabled = true;
      var ok = state.videos.filter(function (x) { return x.data.status === "ok"; }).length;
      el.emptyStats.textContent = state.weeks.length + "週分のまとめ · 動画" + state.videos.length + "本（要約" + ok + "本）";
      return;
    }
    el.readerEmpty.hidden = true;
    el.readerContent.hidden = false;
    el.readerContent.innerHTML = e.kind === "week" ? weekReaderHtml(e) : videoReaderHtml(e);
    el.readerScroll.scrollTop = 0;
    var idx = state.visible.indexOf(e);
    el.readerPos.textContent = idx >= 0 ? (idx + 1) + " / " + state.visible.length : "";
    el.prevBtn.disabled = idx <= 0;
    el.nextBtn.disabled = idx < 0 || idx >= state.visible.length - 1;
    el.starBtn.disabled = false; el.readBtn.disabled = false;
    updateActionButtons(e);
  }

  function updateActionButtons(e) {
    var starred = state.star.has(e.key), read = state.read.has(e.key);
    el.starBtn.setAttribute("aria-pressed", starred ? "true" : "false");
    el.starBtn.innerHTML = '<svg><use href="#i-' + (starred ? "star-fill" : "star") + '"/></svg>';
    el.readBtn.classList.toggle("is-on", read);
    el.readBtn.innerHTML = '<svg><use href="#i-check"/></svg><span class="read-btn-label">' + (read ? "既読" : "未読") + "</span>";
    el.readBtn.title = read ? "未読に戻す（m）" : "既読にする（m）";
  }

  // ---------- 操作 ----------
  function renderAll() { renderNav(); renderList(); }

  function select(key, opts) {
    opts = opts || {};
    var e = state.byKey[key];
    if (!e) return;
    // 別の種類のものへ移るときは、その種類のモードに切り替える
    var wantMode = e.kind === "video" ? "videos" : "weeks";
    var modeChanged = false;
    if (state.mode !== wantMode) {
      state.mode = wantMode;
      saveStr(KEYS.mode, wantMode);
      if (!isValidFilter(state.filter)) state.filter = "all";
      modeChanged = true;
    }
    var prevKey = state.selected;
    state.selected = key;
    if (!state.read.has(key)) { state.read.add(key); saveSet(KEYS.read, state.read); }
    computeVisible();
    if (state.visible.indexOf(e) < 0) {
      // 絞り込みの外にあるものを開いたら、絞り込みを「すべて」に戻す
      state.filter = e.kind === "video" && state.filter.indexOf("week:") === 0 ? state.filter : "all";
      computeVisible();
      if (state.visible.indexOf(e) < 0) { state.filter = "all"; computeVisible(); }
      renderAll();
    } else if (modeChanged) {
      renderAll();   // 一覧の種類が変わったので描き直す
    } else {
      renderNav();
      if (prevKey) refreshRow(prevKey);
      refreshRow(key);
      renderListCountOnly();
    }
    renderReader(e);
    if (isMobile()) document.body.classList.add("is-reader-open");
    if (!opts.silent) history.replaceState(null, "", "#" + key.replace(":", "/"));
    if (!opts.noScroll) {
      var btn = el.listScroll.querySelector('[data-key="' + CSS.escape(key) + '"]');
      if (btn && btn.scrollIntoView) btn.scrollIntoView({ block: "nearest" });
    }
  }

  function step(delta) {
    if (!state.visible.length) return;
    var idx = state.selected ? state.visible.indexOf(state.byKey[state.selected]) : -1;
    var next = idx < 0 ? (delta > 0 ? 0 : state.visible.length - 1) : idx + delta;
    if (next < 0 || next >= state.visible.length) return;
    select(state.visible[next].key);
  }

  function toggleRead(key) {
    if (state.read.has(key)) state.read.delete(key); else state.read.add(key);
    saveSet(KEYS.read, state.read);
    refreshRow(key); renderNav(); renderListCountOnly();
    if (state.selected === key) updateActionButtons(state.byKey[key]);
  }
  function toggleStar(key) {
    if (state.star.has(key)) state.star.delete(key); else state.star.add(key);
    saveSet(KEYS.star, state.star);
    refreshRow(key); renderNav();
    if (state.selected === key) updateActionButtons(state.byKey[key]);
  }
  function markAllRead() {
    state.visible.forEach(function (e) { state.read.add(e.key); });
    saveSet(KEYS.read, state.read);
    renderAll();
    if (state.selected) updateActionButtons(state.byKey[state.selected]);
  }

  function setMode(mode) {
    if (mode !== "weeks" && mode !== "videos") return;
    state.mode = mode;
    saveStr(KEYS.mode, mode);
    if (mode === "weeks" && state.filter.indexOf("channel:") === 0) state.filter = "all";
    afterFilterChange();
    history.replaceState(null, "", "#" + mode);
  }

  function setFilter(f) {
    if (!isValidFilter(f)) return;
    if (f.indexOf("channel:") === 0 && state.mode !== "videos") { state.mode = "videos"; saveStr(KEYS.mode, "videos"); }
    state.filter = f;
    saveStr(KEYS.filter, f);
    afterFilterChange();
  }

  function afterFilterChange() {
    renderAll();
    var cur = state.selected ? state.byKey[state.selected] : null;
    if (cur && state.visible.indexOf(cur) < 0) {
      state.selected = null;
      renderReader(null);
    } else if (cur) {
      renderReader(cur);
    }
    closeDrawer();
    el.listScroll.scrollTop = 0;
  }

  // ---------- チャンネル追加（GitHub の Issue を受け口にする。静的サイトなので直接は書けない） ----------
  function channelRequestUrl(value) {
    var app = state.data.app;
    var title = "チャンネル追加: " + value;
    var body = "channel: " + value + "\n\n（YouTube Digest の「チャンネルを追加」から送信）";
    return "https://github.com/" + app.request_repo + "/issues/new" +
      "?labels=" + encodeURIComponent(app.request_label || "channel-request") +
      "&title=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(body);
  }
  function validateChannelInput(v) {
    v = v.trim();
    if (!v) return "URL か @ハンドルを入力してください。";
    if (/^UC[A-Za-z0-9_-]{22}$/.test(v)) return "";
    if (/^@?[A-Za-z0-9._-]{3,60}$/.test(v)) return "";
    if (/^(https?:\/\/)?(www\.|m\.)?(youtube\.com|youtu\.be)\//i.test(v)) return "";
    return "YouTube のチャンネルURL、@ハンドル、または動画URLを入力してください。";
  }
  function openChannelDialog() {
    el.channelError.hidden = true;
    el.channelInput.value = "";
    if (typeof el.channelDialog.showModal === "function") el.channelDialog.showModal();
    else el.channelDialog.setAttribute("open", "");
    setTimeout(function () { el.channelInput.focus(); }, 50);
  }
  function closeChannelDialog() {
    if (el.channelDialog.open && typeof el.channelDialog.close === "function") el.channelDialog.close();
    else el.channelDialog.removeAttribute("open");
  }
  function submitChannel(ev) {
    ev.preventDefault();
    var v = el.channelInput.value.trim();
    var err = validateChannelInput(v);
    if (err) { el.channelError.textContent = err; el.channelError.hidden = false; el.channelInput.focus(); return; }
    var w = window.open(channelRequestUrl(v), "_blank", "noopener");
    if (!w) location.href = channelRequestUrl(v);
    closeChannelDialog();
    closeDrawer();
  }

  // ---------- 通知（Web Push）----------
  // 端末の購読情報は、チャンネル追加と同じく GitHub の Issue で本体リポジトリ（非公開）に届ける。
  // 実際の通知は、週のまとめが公開されたあとに GitHub Actions が送る。
  var push = { reg: null, sub: null };

  function pushEnv() {
    var ua = navigator.userAgent || "";
    var ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    var standalone = (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
    var supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
    return { ios: ios, standalone: standalone, supported: supported };
  }
  function urlBase64ToUint8Array(s) {
    var pad = "=".repeat((4 - s.length % 4) % 4);
    var raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }
  function pushIssueUrl(kind, sub) {
    var app = state.data.app;
    var title = kind === "push-subscribe" ? "通知登録" : "通知解除";
    var body = kind + "\nsubscription: " + JSON.stringify(sub.toJSON ? sub.toJSON() : sub) +
      "\n\n（YouTube Digest の通知設定から送信。この情報はこの端末に通知を届けるためだけに使われます）";
    return "https://github.com/" + app.request_repo + "/issues/new?labels=" + encodeURIComponent(kind) +
      "&title=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(body);
  }
  function pushUi(status, opts) {
    opts = opts || {};
    el.pushBox.hidden = false;
    el.pushStatus.textContent = status;
    el.pushStatus.classList.toggle("is-on", !!opts.on);
    el.pushBtn.hidden = !opts.button;
    if (opts.button) { el.pushBtn.textContent = opts.button; el.pushBtn.onclick = opts.onClick || null; }
    el.pushLink.hidden = !opts.link;
    if (opts.link) { el.pushLink.textContent = opts.link; el.pushLink.href = opts.href; el.pushLink.onclick = opts.onLink || null; }
  }
  function setupPush() {
    var app = state.data.app;
    if (!app.vapid_public_key || !app.request_repo) return;
    var env = pushEnv();
    if (!env.supported) {
      if (env.ios && !env.standalone) pushUi("通知は、ホーム画面に追加したアプリから設定できます。");
      return;
    }
    navigator.serviceWorker.register("./sw.js").then(function (reg) {
      push.reg = reg;
      if (navigator.clearAppBadge) navigator.clearAppBadge().catch(function () {});
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      push.sub = sub;
      renderPush();
    }).catch(function () {
      pushUi("通知の準備に失敗しました。ページを再読み込みしてください。");
    });
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && navigator.clearAppBadge) navigator.clearAppBadge().catch(function () {});
    });
  }
  function renderPush() {
    var env = pushEnv();
    if (Notification.permission === "denied") {
      pushUi("通知がブロックされています。iPhoneの「設定」→「通知」からこのアプリを許可してください。");
      return;
    }
    if (env.ios && !env.standalone) {
      pushUi("通知は、ホーム画面に追加したアプリから設定できます。");
      return;
    }
    var registered = loadStr("ytd-push-registered", "");
    if (push.sub && registered === push.sub.endpoint) {
      pushUi("通知: オン。新しい週のまとめが公開されたら届きます。", {
        on: true, button: "通知を止める", onClick: unsubscribePush
      });
    } else if (push.sub) {
      pushUi("この端末の登録がまだ送られていません。", {
        link: "登録を送る（GitHubが開きます）", href: pushIssueUrl("push-subscribe", push.sub),
        onLink: function () { saveStr("ytd-push-registered", push.sub.endpoint); setTimeout(renderPush, 500); }
      });
    } else {
      pushUi("新しい週のまとめが出たら、この端末に通知を届けます。", {
        button: "通知を受け取る", onClick: subscribePush
      });
    }
  }
  function subscribePush() {
    if (!push.reg) return;
    pushUi("許可を確認しています…");
    Notification.requestPermission().then(function (perm) {
      if (perm !== "granted") { renderPush(); return null; }
      return push.reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(state.data.app.vapid_public_key)
      });
    }).then(function (sub) {
      if (!sub) return;
      push.sub = sub;
      // 許可ダイアログの後は自動でウィンドウを開けないので、次はリンクを押してもらう
      renderPush();
    }).catch(function (e) {
      pushUi("通知の登録に失敗しました: " + (e && e.message ? e.message : "不明なエラー"), {
        button: "もう一度試す", onClick: subscribePush
      });
    });
  }
  function unsubscribePush() {
    var sub = push.sub;
    if (!sub) { renderPush(); return; }
    var href = pushIssueUrl("push-unsubscribe", sub);
    sub.unsubscribe().catch(function () {}).then(function () {
      push.sub = null;
      saveStr("ytd-push-registered", "");
      pushUi("この端末では通知をオフにしました。登録の削除も送っておくと確実です。", {
        link: "解除を送る（GitHubが開きます）", href: href,
        onLink: function () { setTimeout(renderPush, 500); },
        button: "閉じる", onClick: renderPush
      });
    });
  }

  function openDrawer() { document.body.classList.add("is-drawer-open"); el.scrim.hidden = false; }
  function closeDrawer() { document.body.classList.remove("is-drawer-open"); el.scrim.hidden = true; }
  function closeReader() { document.body.classList.remove("is-reader-open"); }

  function applyHash() {
    var h = decodeURIComponent(location.hash || "").replace(/^#/, "");
    if (h === "videos" || h === "weeks") { setMode(h); return; }
    var m = /^(w|v)\/(.+)$/.exec(h);
    if (m && state.byKey[m[1] + ":" + m[2]]) select(m[1] + ":" + m[2], { silent: true });
  }

  function renderFoot() {
    var built = state.data.app.built_at ? new Date(state.data.app.built_at) : null;
    if (built && !isNaN(built)) {
      el.builtAt.textContent = built.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
      el.builtAt.dateTime = built.toISOString();
      var days = (Date.now() - built.getTime()) / 86400000;
      if (days > STALE_DAYS) {
        el.noticeStale.hidden = false;
        el.noticeStale.textContent = "更新が" + Math.floor(days) + "日止まっています。自宅Macの自動実行（毎週土曜13時）が失敗している可能性があります。";
      }
    } else {
      el.builtAt.textContent = "不明";
    }
  }

  // ---------- イベント ----------
  function bindEvents() {
    document.addEventListener("click", function (e) {
      var t = e.target.closest("[data-mode], [data-filter], [data-key], [data-goto], [data-videos-of]");
      if (!t) return;
      if (t.dataset.videosOf) { state.mode = "videos"; saveStr(KEYS.mode, "videos"); setFilter("week:" + t.dataset.videosOf); return; }
      if (t.dataset.goto) { select(t.dataset.goto); return; }
      if (t.dataset.key) { select(t.dataset.key, { noScroll: true }); return; }
      if (t.dataset.mode) { setMode(t.dataset.mode); return; }
      if (t.dataset.filter) { setFilter(t.dataset.filter); }
    });
    el.menuBtn.addEventListener("click", openDrawer);
    el.drawerClose.addEventListener("click", closeDrawer);
    el.scrim.addEventListener("click", closeDrawer);
    el.readerBack.addEventListener("click", closeReader);
    el.prevBtn.addEventListener("click", function () { step(-1); });
    el.nextBtn.addEventListener("click", function () { step(1); });
    el.starBtn.addEventListener("click", function () { if (state.selected) toggleStar(state.selected); });
    el.readBtn.addEventListener("click", function () { if (state.selected) toggleRead(state.selected); });
    el.markAll.addEventListener("click", markAllRead);
    el.themeToggle.addEventListener("click", cycleTheme);
    el.addChannel.addEventListener("click", openChannelDialog);
    el.channelCancel.addEventListener("click", closeChannelDialog);
    el.channelForm.addEventListener("submit", submitChannel);
    el.channelDialog.addEventListener("click", function (e) { if (e.target === el.channelDialog) closeChannelDialog(); });

    var timer = null;
    el.search.addEventListener("input", function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        state.query = el.search.value;
        renderList();
        if (state.selected) renderReader(state.byKey[state.selected]);
      }, 120);
    });
    el.search.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { el.search.value = ""; state.query = ""; renderList(); el.search.blur(); }
      if (e.key === "Enter") { el.search.blur(); if (!state.selected && state.visible.length) select(state.visible[0].key); }
    });

    document.addEventListener("keydown", function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      var tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      switch (e.key) {
        case "j": case "ArrowDown": if (tag !== "button" || e.key === "j") { e.preventDefault(); step(1); } break;
        case "k": case "ArrowUp": if (tag !== "button" || e.key === "k") { e.preventDefault(); step(-1); } break;
        case "m": if (state.selected) toggleRead(state.selected); break;
        case "s": if (state.selected) toggleStar(state.selected); break;
        case "/": e.preventDefault(); el.search.focus(); el.search.select(); break;
        case "Escape":
          if (document.body.classList.contains("is-drawer-open")) closeDrawer();
          else if (isMobile()) closeReader();
          break;
      }
    });

    window.addEventListener("hashchange", applyHash);
    window.matchMedia(MOBILE).addEventListener("change", function (m) { if (!m.matches) { closeDrawer(); closeReader(); } });
  }

  boot();
})();
