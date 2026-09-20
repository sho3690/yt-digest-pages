/* YouTube Digest — 閲覧アプリ本体
   data.json（ビルド済み・本文HTMLはエスケープ済み）を読み、3つのタブで表示する。
     週のまとめ     … weeks（1週 = 1本）
     動画           … videos（1動画 = 1本。要約が無いものは状態だけ）
     登録チャンネル … registered（追加・削除・停止・再開を GitHub の Issue で送る）
   既読・表示モード・絞り込みは端末内（localStorage）だけに保存する。 */
(function () {
  "use strict";

  var KEYS = { read: "ytd-read", theme: "ytd-theme", mode: "ytd-mode", unread: "ytd-unread" };
  var STALE_DAYS = 3;      // 毎朝の更新がこれ以上止まっていたら知らせる
  var MOBILE = "(max-width: 960px)";
  var TABS = { weeks: "週のまとめ", videos: "動画", channels: "登録チャンネル" };

  var state = {
    data: null, weeks: [], videos: [], byKey: {}, weekById: {},
    mode: "weeks", unread: false, week: "", channel: "", query: "", selected: null, visible: [],
    read: new Set(), theme: "system"
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
    ["tabbar", "badge-weeks", "badge-videos", "notice-stale", "built-at", "theme-toggle", "theme-label",
     "list-title", "list-count", "mark-all", "list-tools", "search", "filter-seg", "week-wrap", "week-select",
     "channel-wrap", "channel-select", "list-scroll", "channels-page", "reader-back", "prev-btn", "next-btn",
     "reader-pos", "read-btn", "reader-scroll", "reader-empty", "reader-content", "empty-stats",
     "manage-add-form", "manage-input", "manage-error", "manage-list", "manage-status", "manage-note",
     "manage-settings", "manage-reset", "manage-send",
     "token-dialog", "token-form", "token-input", "token-error", "token-forget", "token-cancel", "token-save", "token-repo"]
      .forEach(function (id) {
        el[id.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); })] = document.getElementById(id);
      });

    state.read = loadSet(KEYS.read);
    state.theme = loadStr(KEYS.theme, "system");
    state.unread = loadStr(KEYS.unread, "0") === "1";
    applyTheme();
    forgetRetiredFeatures();

    fetch("./data.json?v=" + encodeURIComponent(window.YTD_BUILD || Date.now()), { cache: "no-cache" })
      .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
      .then(init)
      .catch(function (e) {
        el.listScroll.innerHTML = '<div class="list__empty">データを読み込めませんでした。<br>通信状態を確認して、再読み込みしてください。<br><small>' + esc(e.message) + "</small></div>";
      });
  }

  /* 廃止した機能（通知・スター）の名残を片づける:
     端末に残った保存データと、通知のために登録した Service Worker を外す。 */
  function forgetRetiredFeatures() {
    ["ytd-star", "ytd-filter", "ytd-push-registered"].forEach(function (k) {
      try { localStorage.removeItem(k); } catch (e) { /* noop */ }
    });
    if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
      navigator.serviceWorker.getRegistrations().then(function (regs) {
        regs.forEach(function (r) { r.unregister().catch(function () {}); });
      }).catch(function () {});
    }
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
        .concat(v.points.map(stripTags), v.sections,
          (v.outline || []).map(function (o) { return o.heading + " " + stripTags(o.summary); }))
        .join(" ").toLowerCase();
      return { key: "v:" + v.id, kind: "video", id: v.id, week: v.week, data: v, _text: text };
    });
    state.weeks.concat(state.videos).forEach(function (e) { state.byKey[e.key] = e; });

    // 既読は存在するものだけ残す（古い形式のIDも捨てる）
    state.read = new Set(Array.from(state.read).filter(function (k) { return state.byKey[k]; }));

    var m = loadStr(KEYS.mode, "weeks");
    state.mode = TABS[m] ? m : "weeks";

    bindEvents();
    renderAll();
    renderReader(null);
    renderFoot();
    applyHash();
  }

  // ---------- テーマ ----------
  function applyTheme() {
    var root = document.documentElement;
    if (state.theme === "light" || state.theme === "dark") root.dataset.theme = state.theme;
    else delete root.dataset.theme;
    if (el.themeLabel) el.themeLabel.textContent = ({ system: "システム", light: "ライト", dark: "ダーク" })[state.theme];
  }
  function cycleTheme() {
    state.theme = ({ system: "light", light: "dark", dark: "system" })[state.theme] || "system";
    saveStr(KEYS.theme, state.theme);
    applyTheme();
  }

  // ---------- 絞り込み ----------
  function pool() { return state.mode === "videos" ? state.videos : state.mode === "weeks" ? state.weeks : []; }

  function matches(e) {
    if (state.unread && state.read.has(e.key) && e.key !== state.selected) return false;
    if (e.kind === "video") {
      if (state.week && e.week !== state.week) return false;
      if (state.channel && e.data.channel !== state.channel) return false;
    }
    var q = state.query.trim().toLowerCase();
    if (q) {
      var terms = q.split(/\s+/);
      for (var i = 0; i < terms.length; i++) if (e._text.indexOf(terms[i]) < 0) return false;
    }
    return true;
  }
  function computeVisible() { state.visible = pool().filter(matches); }

  function unreadIn(list, pred) {
    var n = 0;
    list.forEach(function (e) { if (!state.read.has(e.key) && (!pred || pred(e))) n++; });
    return n;
  }

  // ---------- タブと絞り込みの表示 ----------
  function renderTabs() {
    Array.prototype.forEach.call(el.tabbar.querySelectorAll("[data-tab]"), function (b) {
      var on = b.dataset.tab === state.mode;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    el.badgeWeeks.textContent = unreadIn(state.weeks) || "";
    el.badgeVideos.textContent = unreadIn(state.videos) || "";
    document.body.classList.toggle("is-channels", state.mode === "channels");
  }

  function option(value, label, selected) {
    return '<option value="' + esc(value) + '"' + (selected ? " selected" : "") + ">" + esc(label) + "</option>";
  }

  function renderFilters() {
    var reading = state.mode !== "channels";
    el.listTools.hidden = !reading;
    el.markAll.hidden = !reading;
    Array.prototype.forEach.call(el.filterSeg.querySelectorAll("[data-unread]"), function (b) {
      var on = (b.dataset.unread === "1") === state.unread;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    var videos = state.mode === "videos";
    el.weekWrap.hidden = !videos;
    el.channelWrap.hidden = !videos;
    if (!videos) return;
    el.weekSelect.innerHTML = option("", "すべての週", !state.week) + state.data.weeks.map(function (w) {
      var n = state.videos.filter(function (e) { return e.week === w.id; }).length;
      return option(w.id, w.label + (w.pending ? "（今週）" : "") + " · " + n + "本", state.week === w.id);
    }).join("");
    el.channelSelect.innerHTML = option("", "すべてのチャンネル", !state.channel) + state.data.channels.map(function (c) {
      return option(c.name, c.name + (c.count ? " · " + c.count + "本" : ""), state.channel === c.name);
    }).join("");
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
    var thumbs = w.thumbs.length
      ? '<span class="row__mosaic">' + w.thumbs.slice(0, 4).map(function (t) {
          return '<span style="background-image:url(&quot;' + esc(t) + '&quot;)"></span>';
        }).join("") + "</span>"
      : '<span class="row__thumb row__thumb--empty"><svg><use href="#i-play"/></svg></span>';
    var meta = 'テーマ' + w.sections.length + " · 動画" + w.video_count + "本" +
      (w.summarized ? "（要約" + w.summarized + "本）" : "");
    var title = w.headline ? w.headline : w.label + " の週";
    var chan = w.headline ? esc(w.label) + " · " + esc(meta) : esc(w.date.slice(0, 4)) + "年 · " + esc(meta);
    if (w.pending) {
      chan = '<span class="badge badge--blue">まとめ待ち</span>' + esc(w.date.slice(0, 4)) + "年 · 動画" + w.video_count + "本" +
        (w.summarized ? "（要約" + w.summarized + "本）" : "");
    }
    return '<button type="button" class="' + cls + '" data-key="' + esc(e.key) + '">' +
      '<span class="row__main">' +
        '<span class="row__meta"><span class="row__chan">' + chan + "</span></span>" +
        '<span class="row__title row__title--week">' + esc(title) + "</span>" +
        (w.excerpt ? '<span class="row__excerpt">' + esc(w.excerpt) + "</span>" : "") +
      "</span>" + thumbs + "</button>";
  }

  function videoRowHtml(e) {
    var v = e.data;
    var cls = "row" + (state.read.has(e.key) ? "" : " is-unread") + (e.key === state.selected ? " is-selected" : "");
    var date = fmtDate(v.published);
    var thumb = v.thumb
      ? '<span class="row__thumb" style="background-image:url(&quot;' + esc(v.thumb) + '&quot;)"></span>'
      : '<span class="row__thumb row__thumb--empty"><svg><use href="#i-play"/></svg></span>';
    var excerpt = v.excerpt || (v.status === "pending" ? "要約はまだ作られていません。" :
      v.status === "no_subtitle" ? "字幕が取得できなかったため、要約はありません。" :
      v.status === "unavailable" ? "この動画は非公開または削除されています。" : "");
    return '<button type="button" class="' + cls + '" data-key="' + esc(e.key) + '">' +
      '<span class="row__main">' +
        '<span class="row__meta">' + statusBadge(v) + '<span class="row__chan">' + esc(v.channel) + (date ? " · " + date : "") + "</span></span>" +
        '<span class="row__title">' + esc(v.title) + "</span>" +
        (excerpt ? '<span class="row__excerpt">' + esc(excerpt) + "</span>" : "") +
      "</span>" + thumb + "</button>";
  }

  function rowHtml(e) { return e.kind === "week" ? weekRowHtml(e) : videoRowHtml(e); }

  function renderList() {
    el.listTitle.textContent = TABS[state.mode];
    var channels = state.mode === "channels";
    el.listScroll.hidden = channels;
    el.channelsPage.hidden = !channels;
    if (channels) {
      el.listCount.textContent = (state.data.registered || []).length + "チャンネル";
      renderManage();
      return;
    }
    computeVisible();
    renderListCountOnly();

    if (!state.visible.length) {
      var msg = state.query ? "「" + esc(state.query) + "」に一致するものはありません。" :
        state.unread ? "未読はありません。<br>今週もお疲れさまでした。" : "まだありません。";
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

  function pendingWeekHtml(e) {
    var w = e.data, parts = [];
    parts.push('<p class="kicker"><span class="kicker__week">今週</span><span class="kicker__sep">·</span><span>' + esc(w.date.slice(0, 4)) + "年</span></p>");
    parts.push('<h1 class="headline">' + esc(w.label) + " の週</h1>");
    parts.push('<p class="subline">動画 ' + w.video_count + "本" + (w.summarized ? "（要約 " + w.summarized + "本）" : "") +
      (w.channels.length ? " · " + esc(w.channels.slice(0, 4).join(" / ")) + (w.channels.length > 4 ? " ほか" : "") : "") + "</p>");
    var sat = w.date.slice(5).split("-").map(function (x) { return String(parseInt(x, 10)); }).join("/");
    parts.push('<div class="notice notice--muted">この週のまとめはまだありません。' + esc(sat) +
      "（土）13時ごろの自動処理で、1週間分をまとめて作ります。動画ごとの要約は毎朝追加されます。</div>");
    var vids = w.video_ids.filter(function (id) { return state.byKey["v:" + id]; });
    if (vids.length) {
      parts.push('<section class="skeleton"><h2 class="sources__title">ここまでの動画 <span class="n">' + vids.length + '</span></h2><div class="vchips">' +
        vids.map(videoChipHtml).join("") + "</div></section>");
    }
    parts.push('<div class="reader__cta"><button type="button" class="textbtn" data-videos-of="' + esc(w.id) + '"><svg><use href="#i-play"/></svg><span>この週の動画を一覧で見る</span></button></div>');
    parts.push(footNav(e));
    return parts.join("");
  }

  function weekReaderHtml(e) {
    var w = e.data, parts = [];
    if (w.pending) return pendingWeekHtml(e);
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
      // 骨格つきの要約: 結論 → 骨格（見出しと中身）→ 話のつながり
      parts.push('<div class="body body--lead"><p>' + v.summary + "</p></div>");
      parts.push('<section class="skeleton"><h2 class="sources__title">動画の骨格 <span class="n">' + v.outline.length + "</span></h2>" +
        '<ol class="outline">' + v.outline.map(function (sec, i) {
          return '<li class="outline__item">' +
            '<div class="outline__head"><span class="outline__no">' + (i + 1) + "</span>" +
              (sec.role ? '<span class="outline__role">' + esc(sec.role) + "</span>" : "") +
              '<h3 class="outline__title">' + esc(sec.heading) + "</h3></div>" +
            '<p class="outline__summary">' + sec.summary + "</p>" +
            "</li>";
        }).join("") + "</ol></section>");
      if (v.flow) parts.push('<section class="flowbox"><h2 class="sources__title">話のつながり</h2><p>' + v.flow + "</p></section>");
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
      el.readBtn.disabled = true;
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
    el.readBtn.disabled = false;
    updateActionButtons(e);
  }

  function updateActionButtons(e) {
    var read = state.read.has(e.key);
    el.readBtn.classList.toggle("is-on", read);
    el.readBtn.innerHTML = '<svg><use href="#i-check"/></svg><span class="read-btn-label">' + (read ? "既読" : "未読") + "</span>";
    el.readBtn.title = read ? "未読に戻す（m）" : "既読にする（m）";
  }

  // ---------- 操作 ----------
  function renderAll() { renderTabs(); renderFilters(); renderList(); }

  function select(key, opts) {
    opts = opts || {};
    var e = state.byKey[key];
    if (!e) return;
    // 別の種類のものへ移るときは、その種類のタブに切り替える
    var wantMode = e.kind === "video" ? "videos" : "weeks";
    var modeChanged = false;
    if (state.mode !== wantMode) {
      state.mode = wantMode;
      saveStr(KEYS.mode, wantMode);
      modeChanged = true;
    }
    var prevKey = state.selected;
    state.selected = key;
    if (!state.read.has(key)) { state.read.add(key); saveSet(KEYS.read, state.read); }
    computeVisible();
    if (state.visible.indexOf(e) < 0) {
      // 絞り込みの外にあるものを開いたら、その絞り込みを外す
      if (e.kind === "video") {
        if (state.week && state.week !== e.week) state.week = "";
        if (state.channel && state.channel !== e.data.channel) state.channel = "";
      }
      computeVisible();
      if (state.visible.indexOf(e) < 0) { state.unread = false; saveStr(KEYS.unread, "0"); computeVisible(); }
      renderAll();
    } else if (modeChanged) {
      renderAll();   // 一覧の種類が変わったので描き直す
    } else {
      renderTabs();
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
    refreshRow(key); renderTabs(); renderListCountOnly();
    if (state.selected === key) updateActionButtons(state.byKey[key]);
  }
  function markAllRead() {
    state.visible.forEach(function (e) { state.read.add(e.key); });
    saveSet(KEYS.read, state.read);
    renderAll();
    if (state.selected) updateActionButtons(state.byKey[state.selected]);
  }

  function setMode(mode) {
    if (!TABS[mode]) return;
    state.mode = mode;
    saveStr(KEYS.mode, mode);
    afterFilterChange();
    history.replaceState(null, "", "#" + mode);
  }
  function setUnread(on) {
    state.unread = !!on;
    saveStr(KEYS.unread, on ? "1" : "0");
    afterFilterChange();
  }
  function setWeek(id) {
    state.week = id && state.weekById[id] ? id : "";
    afterFilterChange();
  }
  function setChannel(name) {
    state.channel = name && state.data.channels.some(function (c) { return c.name === name; }) ? name : "";
    afterFilterChange();
  }
  // 「この週の動画を見る」「このチャンネルの動画を見る」: 動画タブへ移り、その条件で絞り込む
  function showVideosOf(weekId, channel) {
    state.mode = "videos";
    saveStr(KEYS.mode, "videos");
    state.week = weekId && state.weekById[weekId] ? weekId : "";
    state.channel = channel || "";
    afterFilterChange();
    history.replaceState(null, "", "#videos");
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
    closeReader();   // タブや絞り込みを変えたら一覧に戻る（PCでは本文の欄はそのまま）
    el.listScroll.scrollTop = 0;
  }

  // ---------- チャンネルの管理 ----------
  // 静的サイトなので channels.yaml に直接は書けない。変更（追加・削除・停止・再開）は手元にため、
  // 「変更を送る」で GitHub の Issue に1件にまとめて届ける（channel-request.yml が処理して閉じる）。
  // 端末に鍵（fine-grained token, Issues 書き込みだけ）が保存されていれば API で直接 Issue を立て、
  // 結果コメントまで待って画面に出す。無ければ GitHub の Issue 作成画面を開く（従来どおり）。
  var M = window.YTD_MANAGE;
  var TOKEN_KEY = "ytd-gh-token";
  var GH_API = "https://api.github.com";
  var POLL_MS = 6000, POLL_MAX = 40;   // 結果を待つのは最長 4 分
  var manage = { changes: M.empty(), busy: false };

  function ghToken() { return loadStr(TOKEN_KEY, ""); }
  function showDialog(d) { if (typeof d.showModal === "function") { if (!d.open) d.showModal(); } else d.setAttribute("open", ""); }
  function hideDialog(d) { if (d.open && typeof d.close === "function") d.close(); else d.removeAttribute("open"); }

  function renderManage() {
    var rows = M.rows(state.data.registered || [], manage.changes);
    var html = manage.changes.adds.map(function (v) {
      return '<li class="mrow mrow--pending"><div class="mrow__main"><span class="mrow__name">' + esc(v) + '</span>' +
        '<span class="mrow__meta">追加予定</span></div><div class="mrow__actions">' +
        '<button type="button" class="textbtn" data-undo-add="' + esc(v) + '">取り消す</button></div></li>';
    }).concat(rows.map(function (r) {
      var meta = r.pending ? M.OPS[r.pending] + "予定"
        : (r.enabled ? "収集中" : "停止中") + (r.count ? " · 動画 " + r.count + "本" : "");
      var actions = r.pending
        ? '<button type="button" class="textbtn" data-undo="' + esc(r.id) + '">取り消す</button>'
        : '<button type="button" class="textbtn" data-op="' + (r.enabled ? "disable" : "enable") + '" data-id="' + esc(r.id) + '">' +
          (r.enabled ? "停止" : "再開") + "</button>" +
          '<button type="button" class="textbtn textbtn--danger" data-op="remove" data-id="' + esc(r.id) + '">削除</button>';
      var cls = "mrow" + (r.pending ? " mrow--pending" : "") + (!r.enabled && !r.pending ? " mrow--off" : "");
      var body = '<span class="mrow__name">' + esc(r.name) + '</span><span class="mrow__meta">' + esc(meta) + "</span>";
      // 動画があるチャンネルは、名前を押すと「動画」タブでそのチャンネルに絞り込む
      var main = r.count && !r.pending
        ? '<button type="button" class="mrow__main mrow__link" data-channel-videos="' + esc(r.name) + '" title="このチャンネルの動画を見る">' + body + "</button>"
        : '<div class="mrow__main">' + body + "</div>";
      return '<li class="' + cls + '">' + main + '<div class="mrow__actions">' + actions + "</div></li>";
    })).join("");
    el.manageList.innerHTML = html || '<li class="mrow mrow--empty">登録チャンネルはまだありません。</li>';

    var n = M.count(manage.changes);
    el.manageSend.disabled = !n || manage.busy;
    el.manageSend.querySelector("span").textContent = manage.busy ? "送信中…" : (n ? "変更を送る（" + n + "件）" : "変更を送る");
    el.manageReset.hidden = !n || manage.busy;
    var hasToken = !!ghToken();
    el.manageNote.textContent = hasToken
      ? "「変更を送る」を押すとアプリ内で送信され、数分で反映されます。"
      : "「変更を送る」を押すとGitHubの画面が開くので、「Submit new issue」を押してください。数分で反映されます。";
    el.manageSettings.textContent = hasToken ? "送信の設定" : "GitHubの画面を開かずに送る設定";
    var canSend = !!(state.data.app && state.data.app.request_repo);
    el.manageAddForm.hidden = !canSend;
    el.manageSend.parentNode.hidden = !canSend;
  }
  function setManageStatus(msg, kind, opts) {
    opts = opts || {};
    if (!msg) { el.manageStatus.hidden = true; el.manageStatus.innerHTML = ""; return; }
    var lines = Array.isArray(msg) ? msg : [msg];
    el.manageStatus.hidden = false;
    el.manageStatus.className = "mstatus mstatus--" + (kind || "info");
    var links = "";
    if (opts.reload) links += '<button type="button" class="textbtn textbtn--small" data-reload>再読み込み</button>';
    if (opts.url) links += '<a href="' + esc(opts.url) + '" target="_blank" rel="noopener noreferrer">GitHubで見る</a>';
    el.manageStatus.innerHTML = lines.map(function (l) { return "<p>" + esc(l) + "</p>"; }).join("") +
      (links ? '<p class="mstatus__links">' + links + "</p>" : "");
    var rb = el.manageStatus.querySelector("[data-reload]");
    if (rb) rb.onclick = function () { location.reload(); };
  }
  function submitAdd(ev) {
    ev.preventDefault();
    var r = M.addRequest(manage.changes, el.manageInput.value);
    if (r.error) { el.manageError.textContent = r.error; el.manageError.hidden = false; el.manageInput.focus(); return; }
    manage.changes = r.changes;
    el.manageError.hidden = true;
    el.manageInput.value = "";
    setManageStatus(null);
    renderManage();
  }
  function onManageListClick(e) {
    var t = e.target.closest("[data-op], [data-undo], [data-undo-add]");
    if (!t || manage.busy) return;
    if (t.dataset.op) manage.changes = M.setOp(manage.changes, t.dataset.id, t.dataset.op);
    else if (t.dataset.undo) manage.changes = M.setOp(manage.changes, t.dataset.undo, null);
    else manage.changes = M.removeAdd(manage.changes, t.dataset.undoAdd);
    setManageStatus(null);
    renderManage();
  }
  function resetChanges() { manage.changes = M.empty(); setManageStatus(null); renderManage(); }

  // GitHub API（鍵があるときだけ使う。送り先は api.github.com のみ）
  function gh(method, path, body, token) {
    var headers = { "Accept": "application/vnd.github+json", "Authorization": "Bearer " + (token || ghToken()),
                    "X-GitHub-Api-Version": "2022-11-28" };
    var opts = { method: method, headers: headers };
    if (body) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch(GH_API + path, opts).then(function (r) {
      if (r.ok) return r.status === 204 ? null : r.json();
      return r.json().catch(function () { return {}; }).then(function (d) {
        var err = new Error(d.message || ("HTTP " + r.status));
        err.status = r.status;
        throw err;
      });
    }, function () {
      var err = new Error("通信できませんでした");
      err.status = 0;
      throw err;
    });
  }
  function ghErrorText(e, doing) {
    var repo = state.data.app.request_repo;
    if (e.status === 401) return "鍵が無効か期限切れです。「送信の設定」から鍵を作り直してください。";
    if (e.status === 403) return "鍵の権限が足りません。鍵の Permissions で Issues が「Read and write」になっているか確認してください。";
    if (e.status === 404) return "リポジトリにアクセスできません。鍵の Repository access に " + repo + " が入っているか確認してください。";
    if (e.status === 0) return "通信できませんでした。電波状況を確認して、もう一度お試しください。";
    return (doing || "処理") + "できませんでした: " + (e.message || "不明なエラー");
  }
  function sendChanges() {
    if (manage.busy || !M.count(manage.changes)) return;
    var app = state.data.app;
    var label = app.request_label || "channel-request";
    var issue = M.buildIssue(manage.changes, state.data.registered || []);
    if (!ghToken()) {
      var url = M.issueUrl(app.request_repo, label, issue);
      var w = window.open(url, "_blank", "noopener");
      if (!w) location.href = url;
      manage.changes = M.empty();
      setManageStatus("GitHubの画面で「Submit new issue」を押すと送信完了です。数分後にアプリを再読み込みすると反映されます。", "info");
      renderManage();
      return;
    }
    manage.busy = true;
    renderManage();
    setManageStatus("送信しています…", "info");
    gh("POST", "/repos/" + app.request_repo + "/issues", { title: issue.title, body: issue.body, labels: [label] })
      .then(function (created) {
        manage.changes = M.empty();
        renderManage();
        setManageStatus("送信しました。反映を待っています…（ふつう1〜2分）", "info", { url: created.html_url });
        return waitForResult(app.request_repo, created.number, created.html_url);
      })
      .catch(function (e) { setManageStatus(ghErrorText(e, "送信"), "error"); })
      .then(function () { manage.busy = false; renderManage(); });
  }
  function waitForResult(repo, number, url) {
    var tries = 0;
    return new Promise(function (resolve) {
      function tick() {
        tries += 1;
        gh("GET", "/repos/" + repo + "/issues/" + number).then(function (is) {
          var failed = (is.labels || []).some(function (l) { return l.name === "needs-attention"; });
          if (is.state !== "closed" && !failed) {
            if (tries >= POLL_MAX) {
              setManageStatus("まだ処理中です。しばらくしてからアプリを再読み込みしてください。", "info", { url: url, reload: true });
              return resolve();
            }
            setTimeout(tick, POLL_MS);
            return;
          }
          return gh("GET", "/repos/" + repo + "/issues/" + number + "/comments?per_page=10").then(function (cs) {
            var last = cs && cs.length ? cs[cs.length - 1].body : "";
            var lines = M.resultLines(last);
            if (!lines.length) lines = [failed ? "処理できませんでした。GitHubで詳細を確認してください。" : "反映しました。"];
            if (!failed) lines.push("再読み込みすると新しい一覧になります（公開の反映に1〜2分かかることがあります）。");
            setManageStatus(lines, failed ? "error" : "ok", { url: url, reload: !failed });
            resolve();
          });
        }).catch(function (e) { setManageStatus(ghErrorText(e, "結果の確認"), "error", { url: url }); resolve(); });
      }
      setTimeout(tick, POLL_MS);
    });
  }

  // 鍵の設定
  function openTokenDialog() {
    el.tokenError.hidden = true;
    el.tokenInput.value = "";
    el.tokenForget.hidden = !ghToken();
    el.tokenRepo.textContent = state.data.app.request_repo;
    showDialog(el.tokenDialog);
  }
  function showTokenError(msg) { el.tokenError.textContent = msg; el.tokenError.hidden = false; el.tokenInput.focus(); }
  function saveToken(ev) {
    ev.preventDefault();
    var t = el.tokenInput.value.trim();
    if (!t) { showTokenError("鍵を貼り付けてください。"); return; }
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(t)) { showTokenError("GitHubの鍵の形式ではありません（github_pat_ から始まる文字列です）。"); return; }
    var btn = el.tokenSave.querySelector("span");
    el.tokenSave.disabled = true;
    btn.textContent = "確認中…";
    // 保存する前に、その鍵でこのリポジトリの Issue が読めるかを確かめる
    gh("GET", "/repos/" + state.data.app.request_repo + "/issues?per_page=1&state=all", null, t)
      .then(function () {
        saveStr(TOKEN_KEY, t);
        hideDialog(el.tokenDialog);
        setManageStatus("鍵を保存しました。以後は「変更を送る」でアプリ内から送れます。", "ok");
        renderManage();
      })
      .catch(function (e) { showTokenError(ghErrorText(e, "確認")); })
      .then(function () { el.tokenSave.disabled = false; btn.textContent = "確認して保存"; });
  }
  function forgetToken() {
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* noop */ }
    hideDialog(el.tokenDialog);
    setManageStatus("鍵を削除しました。GitHubの「Settings → Developer settings」で鍵そのものも無効化しておくと安心です。", "info");
    renderManage();
  }

  function closeReader() { document.body.classList.remove("is-reader-open"); }

  function applyHash() {
    var h = decodeURIComponent(location.hash || "").replace(/^#/, "");
    if (TABS[h]) { setMode(h); return; }
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
        el.noticeStale.textContent = "更新が" + Math.floor(days) + "日止まっています。自宅Macの自動実行（毎朝6時）が動いていない可能性があります。";
      }
    } else {
      el.builtAt.textContent = "不明";
    }
  }

  // ---------- イベント ----------
  function bindEvents() {
    document.addEventListener("click", function (e) {
      var t = e.target.closest("[data-tab], [data-unread], [data-key], [data-goto], [data-videos-of], [data-channel-videos]");
      if (!t) return;
      if (t.dataset.videosOf) { showVideosOf(t.dataset.videosOf, ""); return; }
      if (t.dataset.channelVideos) { showVideosOf("", t.dataset.channelVideos); return; }
      if (t.dataset.goto) { select(t.dataset.goto); return; }
      if (t.dataset.key) { select(t.dataset.key, { noScroll: true }); return; }
      if (t.dataset.tab) { setMode(t.dataset.tab); return; }
      if (t.dataset.unread != null) setUnread(t.dataset.unread === "1");
    });
    el.weekSelect.addEventListener("change", function () { setWeek(el.weekSelect.value); });
    el.channelSelect.addEventListener("change", function () { setChannel(el.channelSelect.value); });
    el.readerBack.addEventListener("click", closeReader);
    el.prevBtn.addEventListener("click", function () { step(-1); });
    el.nextBtn.addEventListener("click", function () { step(1); });
    el.readBtn.addEventListener("click", function () { if (state.selected) toggleRead(state.selected); });
    el.markAll.addEventListener("click", markAllRead);
    el.themeToggle.addEventListener("click", cycleTheme);
    el.manageAddForm.addEventListener("submit", submitAdd);
    el.manageList.addEventListener("click", onManageListClick);
    el.manageReset.addEventListener("click", resetChanges);
    el.manageSend.addEventListener("click", sendChanges);
    el.manageSettings.addEventListener("click", openTokenDialog);
    el.tokenForm.addEventListener("submit", saveToken);
    el.tokenCancel.addEventListener("click", function () { hideDialog(el.tokenDialog); });
    el.tokenForget.addEventListener("click", forgetToken);
    el.tokenDialog.addEventListener("click", function (e) { if (e.target === el.tokenDialog) hideDialog(el.tokenDialog); });

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
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      switch (e.key) {
        case "j": case "ArrowDown": if (tag !== "button" || e.key === "j") { e.preventDefault(); step(1); } break;
        case "k": case "ArrowUp": if (tag !== "button" || e.key === "k") { e.preventDefault(); step(-1); } break;
        case "m": if (state.selected) toggleRead(state.selected); break;
        case "/": e.preventDefault(); el.search.focus(); el.search.select(); break;
        case "Escape": if (isMobile()) closeReader(); break;
      }
    });

    window.addEventListener("hashchange", applyHash);
    window.matchMedia(MOBILE).addEventListener("change", function (m) { if (!m.matches) closeReader(); });
  }

  /* 二本指のピンチ拡大を止める。iPhone の Safari は viewport の user-scalable=no を無視することがあるため、
     Safari 独自の gesture イベントと、2本指の touchmove を止める。1本指のスクロールには触らない。 */
  function lockPinchZoom() {
    ["gesturestart", "gesturechange", "gestureend"].forEach(function (type) {
      document.addEventListener(type, function (e) { e.preventDefault(); }, { passive: false });
    });
    document.addEventListener("touchmove", function (e) {
      if (e.touches.length > 1 || (typeof e.scale === "number" && e.scale !== 1)) e.preventDefault();
    }, { passive: false });
  }

  lockPinchZoom();
  boot();
})();
