/*!
 * جميع الحقوق محفوظة © 2026 صحيفة أحوال الإلكترونية — عبدالله بن صالح بن خميس الكناني
 * يُمنع نسخ هذا البرنامج أو إعادة استخدامه أو توزيعه دون إذن كتابي من المالك.
 */
/* أحوال — موجز السحب */
(function () {
  "use strict";

  const WP_ENDPOINT = "https://ahwal.sa/wp-json/wp/v2/posts";
  const PAGE_SIZE = 20;
  const RSS_URL = "https://ahwal.sa/feed";
  const TZ = "Asia/Riyadh";

  const el = {
    feed: document.getElementById("feed"),
    loader: document.getElementById("loader"),
    status: document.getElementById("feed-status"),
    dots: document.getElementById("dots"),
    counter: document.getElementById("counter"),
    sheet: document.getElementById("sheet"),
    sheetBackdrop: document.getElementById("sheet-backdrop"),
    sheetTitle: document.getElementById("sheet-title"),
    sheetBody: document.getElementById("sheet-body"),
    sheetLink: document.getElementById("sheet-link"),
    toast: document.getElementById("toast"),
    about: document.getElementById("about"),
    empty: null,
  };

  const ICONS = {
    read: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5 15.4 17.5M15.4 6.5 8.6 10.5"/></svg>',
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 13v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 14l6-6 6 6"/></svg>',
    soundOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="m22 9-6 6M16 9l6 6"/></svg>',
    soundOn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  };

  let items = [];
  let activeIndex = 0;
  let hinted = sessionStorage.getItem("ahwal-hinted") === "1";
  let toastTimer = 0;
  let currentSheetItem = null;
  let lastFetchAt = 0;
  let fetching = false;
  let liveSource = "";
  let feedBound = false;
  let cardObserver = null;
  let sentinelObserver = null;
  let currentPage = 0;
  let totalPages = 1;
  let page1Ids = [];
  let loadingMore = false;
  let reachedEnd = false;
  const REFRESH_AFTER_MS = 5 * 60 * 1000;

  function snapshot() {
    return window.AHWAL_SNAPSHOT || { items: [] };
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function stripHtml(html) {
    if (!html) return "";
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    tmp.querySelectorAll("script,style").forEach((n) => n.remove());
    const text = tmp.textContent || tmp.innerText || "";
    return text.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  }

  function formatDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    try {
      return new Intl.DateTimeFormat("ar-SA", {
        timeZone: TZ,
        weekday: "long",
        day: "numeric",
        month: "long",
        hour: "numeric",
        minute: "2-digit",
      }).format(d);
    } catch {
      return d.toLocaleString("ar");
    }
  }

  function extractVideo(html) {
    if (!html) return null;
    const yt = html.match(/(?:youtube\.com\/embed\/|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
    if (yt) {
      return { type: "youtube", id: yt[1], src: "https://www.youtube-nocookie.com/embed/" + yt[1] };
    }
    const mp4 = html.match(/(https?:\/\/[^"'\\s>]+\.mp4)/i);
    if (mp4) return { type: "mp4", src: mp4[1] };
    return null;
  }

  function featuredImage(post) {
    const media = (post._embedded && post._embedded["wp:featuredmedia"]) || [];
    if (media[0]) {
      const sizes = (media[0].media_details && media[0].media_details.sizes) || {};
      for (const key of ["large", "medium_large", "full"]) {
        if (sizes[key] && sizes[key].source_url) return sizes[key].source_url;
      }
      if (media[0].source_url) return media[0].source_url;
    }
    const yoast = post.yoast_head_json;
    if (yoast && yoast.og_image && yoast.og_image[0] && yoast.og_image[0].url) {
      return yoast.og_image[0].url;
    }
    return null;
  }

  function parseWpPosts(posts) {
    return (posts || []).map((post) => {
      const contentHtml = (post.content && post.content.rendered) || "";
      const excerptHtml = (post.excerpt && post.excerpt.rendered) || "";
      const body = stripHtml(contentHtml);
      let excerpt = stripHtml(excerptHtml);
      if (!excerpt) excerpt = body.slice(0, 180) + (body.length > 180 ? "…" : "");
      const terms = (post._embedded && post._embedded["wp:term"]) || [];
      const cats = ((terms[0] || []).map((t) => t.name).filter(Boolean));
      const authors = (post._embedded && post._embedded.author) || [];
      const date = post.date_gmt ? post.date_gmt.replace(" ", "T") + (post.date_gmt.endsWith("Z") ? "" : "Z") : post.date;
      return {
        id: post.id,
        title: stripHtml((post.title && post.title.rendered) || ""),
        link: post.link,
        date,
        author: authors[0] && authors[0].name,
        categories: cats,
        excerpt,
        content: body,
        image: featuredImage(post),
        video: extractVideo(contentHtml),
        source: "live",
      };
    });
  }

  function parseRss(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("rss-parse");
    const nodes = [...doc.querySelectorAll("item")];
    return nodes.map((item, i) => {
      const content =
        (item.getElementsByTagName("content:encoded")[0] &&
          item.getElementsByTagName("content:encoded")[0].textContent) ||
        item.querySelector("description")?.textContent ||
        "";
      const imgMatch = content.match(/<img[^>]+src=["']([^"']+)["']/i);
      const enclosure = item.querySelector("enclosure");
      const media = item.getElementsByTagName("media:content")[0];
      const image =
        (media && media.getAttribute("url")) ||
        (enclosure && /image/i.test(enclosure.getAttribute("type") || "") && enclosure.getAttribute("url")) ||
        (imgMatch && imgMatch[1]) ||
        null;
      const pub = item.querySelector("pubDate")?.textContent;
      const title = item.querySelector("title")?.textContent || "";
      const link = item.querySelector("link")?.textContent || "";
      const body = stripHtml(content);
      const desc = stripHtml(item.querySelector("description")?.textContent || "");
      return {
        id: item.querySelector("guid")?.textContent || i,
        title,
        link,
        date: pub ? new Date(pub).toISOString() : "",
        author: item.getElementsByTagName("dc:creator")[0]?.textContent || "",
        categories: [...item.querySelectorAll("category")].map((c) => c.textContent).filter(Boolean),
        excerpt: desc || body.slice(0, 180),
        content: body,
        image,
        video: extractVideo(content),
        source: "rss",
      };
    });
  }

  function itemSignature(it) {
    const videoId = (it.video && (it.video.id || it.video.src)) || "";
    return [it.id, it.title, it.date, it.excerpt, it.content, it.image || "", videoId, (it.categories || []).join(",")].join("\0");
  }

  function listsEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    return a.every((it, i) => itemSignature(it) === itemSignature(b[i]));
  }

  function fetchOpts(signal) {
    return { signal, cache: "no-store", credentials: "omit" };
  }

  function withBust(url) {
    return url + (url.indexOf("?") >= 0 ? "&" : "?") + "_=" + Date.now();
  }

  function dedupeById(list) {
    const seen = new Set();
    return list.filter((it) => {
      if (it == null || it.id == null || seen.has(it.id)) return false;
      seen.add(it.id);
      return true;
    });
  }

  function wpPageUrl(page) {
    return withBust(
      WP_ENDPOINT + "?per_page=" + PAGE_SIZE + "&page=" + page + "&_embed=1"
    );
  }

  async function fetchWpPage(page) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(wpPageUrl(page), fetchOpts(ctrl.signal));
      const total = parseInt(res.headers.get("X-WP-TotalPages") || "0", 10) || 0;
      if (res.status === 400 || res.status === 404) {
        return { items: [], totalPages: total || page - 1, done: true };
      }
      if (!res.ok) throw new Error("wp-" + res.status);
      const data = await res.json();
      const parsed = parseWpPosts(Array.isArray(data) ? data : []);
      const pages = total || page;
      return {
        items: parsed,
        totalPages: pages,
        done: parsed.length === 0 || page >= pages,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchWpByIds(ids) {
    if (!ids.length) return [];
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const url = withBust(
        WP_ENDPOINT +
          "?include=" +
          ids.map(encodeURIComponent).join(",") +
          "&per_page=" +
          ids.length +
          "&_embed=1"
      );
      const res = await fetch(url, fetchOpts(ctrl.signal));
      if (!res.ok) return [];
      const data = await res.json();
      const parsed = parseWpPosts(Array.isArray(data) ? data : []);
      const order = new Map(ids.map((id, i) => [id, i]));
      parsed.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      return parsed;
    } catch (_) {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  function markPagingFromPage1(result) {
    currentPage = 1;
    totalPages = result.totalPages || 1;
    reachedEnd = !!result.done;
    page1Ids = result.items.map((it) => it.id);
  }

  async function fetchLive() {
    try {
      const result = await fetchWpPage(1);
      if (result.items.length) {
        markPagingFromPage1(result);
        return { items: result.items, source: "live" };
      }
    } catch (_) {
      /* CORS أو الشبكة */
    }
    reachedEnd = true;
    currentPage = 0;
    page1Ids = [];
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      try {
        const res = await fetch(withBust(RSS_URL), fetchOpts(ctrl.signal));
        if (res.ok) {
          const xml = await res.text();
          const parsed = parseRss(xml);
          if (parsed.length) return { items: parsed, source: "rss" };
        }
      } finally {
        clearTimeout(timer);
      }
    } catch (_) {
      /* الموجز بلا CORS عادة */
    }
    return { items: snapshot().items || [], source: "snapshot" };
  }

  function ytUrl(id, { mute = true, autoplay = true } = {}) {
    const params = new URLSearchParams({
      autoplay: autoplay ? "1" : "0",
      mute: mute ? "1" : "0",
      playsinline: "1",
      rel: "0",
      modestbranding: "1",
      enablejsapi: "1",
      origin: location.origin,
    });
    return "https://www.youtube-nocookie.com/embed/" + encodeURIComponent(id) + "?" + params.toString();
  }

  function renderCard(item, index, total) {
    const cat = (item.categories && item.categories[0]) || "أحوال";
    const isVideo = !!(item.video && (item.video.type === "youtube" || item.video.type === "mp4"));
    const img = item.image
      ? `<img src="${escapeHtml(item.image)}" alt="" loading="${index < 2 ? "eager" : "lazy"}" referrerpolicy="no-referrer">`
      : "";
    const videoStage = isVideo
      ? `<div class="video-stage">
          <div class="video-frame" data-video='${escapeHtml(JSON.stringify(item.video))}'>
            ${item.image ? `<img class="video-poster" src="${escapeHtml(item.image)}" alt="">` : ""}
            <button class="unmute-btn hidden" type="button" data-unmute>${ICONS.soundOff}<span>تشغيل الصوت</span></button>
          </div>
        </div>`
      : "";
    const hint =
      index === 0
        ? `<div class="swipe-hint">${ICONS.chevron}<span>اسحب لأعلى للخبر التالي</span></div>`
        : "";
    return `<article class="card${index === 0 ? " is-active" : ""}" data-index="${index}" tabindex="0">
      <div class="card-bg${!item.image ? " is-fallback" : ""}">${img}<div class="card-shade"></div></div>
      ${videoStage}
      <div class="card-body">
        <span class="cat${isVideo ? " is-video" : ""}">${escapeHtml(isVideo ? "فيديو · " + cat : cat)}</span>
        <h2>${escapeHtml(item.title)}</h2>
        <div class="meta">
          <time datetime="${escapeHtml(item.date || "")}">${escapeHtml(formatDate(item.date))}</time>
          ${item.author ? `<span>${escapeHtml(item.author)}</span>` : ""}
        </div>
        ${item.excerpt ? `<p class="excerpt">${escapeHtml(item.excerpt)}</p>` : ""}
        <div class="card-actions">
          <button class="btn btn-primary" type="button" data-more="${index}">${ICONS.read} اقرأ المزيد</button>
          <button class="btn btn-ghost btn-icon" type="button" data-share="${index}" aria-label="مشاركة">${ICONS.share}</button>
          <a class="btn btn-ghost btn-icon" href="${escapeHtml(item.link || "https://ahwal.sa/")}" target="_blank" rel="noopener" aria-label="فتح المقال">${ICONS.open}</a>
        </div>
        ${hint}
      </div>
    </article>`;
  }

  function renderDots(total, active) {
    if (total > 24) {
      el.dots.innerHTML = "";
      el.dots.hidden = true;
    } else {
      el.dots.hidden = false;
      el.dots.innerHTML = Array.from({ length: total }, (_, i) =>
        `<span class="${i === active ? "is-on" : ""}"></span>`
      ).join("");
    }
    el.counter.textContent = `${toArNum(active + 1)} \u202F/\u202F${toArNum(total)}`;
  }

  function toArNum(n) {
    const map = "٠١٢٣٤٥٦٧٨٩";
    return String(n).replace(/\d/g, (d) => map[d]);
  }

  function setStatus(source) {
    el.status.classList.remove("is-live", "is-offline");
    if (source === "live" || source === "rss") {
      el.status.classList.add("is-live");
      el.status.innerHTML = '<span class="dot"></span> مباشر';
      el.status.title = source === "rss" ? "جُلب من الموجز" : "جُلب من الموقع الآن";
    } else {
      el.status.classList.add("is-offline");
      el.status.innerHTML = '<span class="dot"></span> لقطة محفوظة';
      el.status.title = "تعذّر الجلب الحي، نعرض لقطة موجز محفوظة";
    }
  }

  function postToYt(iframe, func) {
    if (!iframe || !iframe.contentWindow) return;
    iframe.contentWindow.postMessage(
      JSON.stringify({ event: "command", func, args: [] }),
      "*"
    );
  }

  function playVideo(card, unmute) {
    const frame = card.querySelector(".video-frame");
    if (!frame) return;
    const data = JSON.parse(frame.getAttribute("data-video") || "{}");
    const btn = frame.querySelector("[data-unmute]");
    if (data.type === "youtube" && data.id) {
      let iframe = frame.querySelector("iframe");
      if (!iframe) {
        iframe = document.createElement("iframe");
        iframe.setAttribute("allow", "autoplay; encrypted-media; picture-in-picture; fullscreen");
        iframe.setAttribute("allowfullscreen", "");
        iframe.title = "فيديو";
        frame.appendChild(iframe);
      }
      iframe.src = ytUrl(data.id, { mute: !unmute, autoplay: true });
      if (btn) {
        btn.classList.toggle("hidden", !!unmute);
        btn.innerHTML = unmute ? ICONS.soundOn + "<span>الصوت</span>" : ICONS.soundOff + "<span>تشغيل الصوت</span>";
      }
    } else if (data.type === "mp4" && data.src) {
      let video = frame.querySelector("video");
      if (!video) {
        video = document.createElement("video");
        video.playsInline = true;
        video.loop = true;
        video.src = data.src;
        frame.appendChild(video);
      }
      video.muted = !unmute;
      video.play().catch(() => {});
      if (btn) btn.classList.toggle("hidden", false);
    }
  }

  function pauseVideo(card) {
    const frame = card.querySelector(".video-frame");
    if (!frame) return;
    const iframe = frame.querySelector("iframe");
    if (iframe) {
      postToYt(iframe, "pauseVideo");
      iframe.src = "about:blank";
      iframe.remove();
    }
    const video = frame.querySelector("video");
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
      video.remove();
    }
  }

  function setActive(index) {
    const cards = [...el.feed.querySelectorAll(".card")];
    cards.forEach((card, i) => {
      const on = i === index;
      card.classList.toggle("is-active", on);
      if (on) playVideo(card, false);
      else pauseVideo(card);
    });
    activeIndex = index;
    renderDots(cards.length, index);
    if (index > 0 && !hinted) {
      hinted = true;
      sessionStorage.setItem("ahwal-hinted", "1");
      document.getElementById("app").classList.add("hint-hidden");
    }
    if (index >= items.length - 3) loadMore();
  }

  function openSheet(item) {
    currentSheetItem = item;
    el.sheetTitle.textContent = item.title;
    const paras = (item.content || item.excerpt || "")
      .split(/\n+/)
      .map((p) => p.trim())
      .filter(Boolean);
    el.sheetBody.innerHTML = paras.length
      ? paras.map((p) => `<p>${escapeHtml(p)}</p>`).join("")
      : "<p>لا يتوفر نص كامل في الموجز. يمكنك فتح المقال على الموقع.</p>";
    el.sheetLink.href = item.link || "https://ahwal.sa/";
    el.sheet.classList.add("open");
    el.sheetBackdrop.classList.add("open");
    el.sheet.setAttribute("aria-hidden", "false");
    const card = el.feed.querySelector(".card.is-active");
    if (card) {
      const iframe = card.querySelector("iframe");
      if (iframe) postToYt(iframe, "pauseVideo");
      const video = card.querySelector("video");
      if (video) video.pause();
    }
  }

  function closeSheet() {
    el.sheet.classList.remove("open");
    el.sheetBackdrop.classList.remove("open");
    el.sheet.setAttribute("aria-hidden", "true");
    currentSheetItem = null;
  }

  async function shareItem(item) {
    const data = {
      title: item.title,
      text: item.excerpt || item.title,
      url: item.link || "https://ahwal.sa/",
    };
    try {
      if (navigator.share) {
        await navigator.share(data);
        return;
      }
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
    try {
      await navigator.clipboard.writeText(data.url);
      showToast("تم نسخ رابط المقال");
    } catch {
      showToast(data.url);
    }
  }

  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove("show"), 2200);
  }

  function bindFeedOnce() {
    if (feedBound) return;
    feedBound = true;
    el.feed.addEventListener("click", (e) => {
      const more = e.target.closest("[data-more]");
      if (more) {
        openSheet(items[Number(more.getAttribute("data-more"))]);
        return;
      }
      const share = e.target.closest("[data-share]");
      if (share) {
        shareItem(items[Number(share.getAttribute("data-share"))]);
        return;
      }
      const unmute = e.target.closest("[data-unmute]");
      if (unmute) {
        const card = unmute.closest(".card");
        playVideo(card, true);
        unmute.classList.add("hidden");
      }
    });

    document.addEventListener("keydown", (e) => {
      if (el.sheet.classList.contains("open")) {
        if (e.key === "Escape") closeSheet();
        return;
      }
      if (e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        const next = el.feed.querySelector(`.card[data-index="${activeIndex + 1}"]`);
        if (next) next.scrollIntoView({ behavior: "smooth" });
      }
      if (e.key === "ArrowUp" || e.key === "PageUp") {
        e.preventDefault();
        const prev = el.feed.querySelector(`.card[data-index="${activeIndex - 1}"]`);
        if (prev) prev.scrollIntoView({ behavior: "smooth" });
      }
    });
  }

  function observeCards() {
    if (cardObserver) cardObserver.disconnect();
    cardObserver = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((en) => en.isIntersecting && en.intersectionRatio >= 0.6)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        if (!visible) return;
        const idx = Number(visible.target.getAttribute("data-index"));
        if (idx !== activeIndex) setActive(idx);
      },
      { root: el.feed, threshold: [0.6, 0.75, 0.9] }
    );
    el.feed.querySelectorAll(".card").forEach((c) => cardObserver.observe(c));
    observeSentinel();
  }

  function ensureSentinel() {
    let s = document.getElementById("load-sentinel");
    if (!s) {
      s = document.createElement("div");
      s.id = "load-sentinel";
      s.className = "load-sentinel";
      s.setAttribute("aria-hidden", "true");
      s.innerHTML = '<div class="spinner"></div><span>جاري تحميل المزيد…</span>';
    }
    el.feed.appendChild(s);
    s.classList.toggle("is-loading", !!loadingMore);
    s.hidden = reachedEnd || liveSource !== "live";
    return s;
  }

  function observeSentinel() {
    const s = ensureSentinel();
    if (sentinelObserver) sentinelObserver.disconnect();
    if (s.hidden) return;
    sentinelObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((en) => en.isIntersecting)) loadMore();
      },
      { root: el.feed, rootMargin: "0px 0px 300% 0px", threshold: 0.01 }
    );
    sentinelObserver.observe(s);
  }

  function appendCards(extra) {
    if (!extra.length) return;
    const start = items.length;
    items = items.concat(extra);
    const s = document.getElementById("load-sentinel");
    const html = extra.map((it, i) => renderCard(it, start + i, items.length)).join("");
    if (s) s.insertAdjacentHTML("beforebegin", html);
    else el.feed.insertAdjacentHTML("beforeend", html);
    renderDots(items.length, activeIndex);
    observeCards();
  }

  async function loadMore() {
    if (loadingMore || fetching || reachedEnd) return;
    if (liveSource !== "live") return;
    if (currentPage >= totalPages) {
      reachedEnd = true;
      ensureSentinel();
      return;
    }
    loadingMore = true;
    ensureSentinel();
    try {
      const result = await fetchWpPage(currentPage + 1);
      if (result.totalPages) totalPages = result.totalPages;
      const existing = new Set(items.map((it) => it.id));
      const extra = result.items.filter((it) => !existing.has(it.id));
      if (!result.items.length) {
        reachedEnd = true;
      } else {
        currentPage += 1;
        if (result.done || currentPage >= totalPages) reachedEnd = true;
        appendCards(extra);
      }
    } catch (_) {
      /* اسمح بإعادة المحاولة عند الاقتراب مجدداً */
    } finally {
      loadingMore = false;
      ensureSentinel();
      observeSentinel();
    }
  }

  function paint(list, source, opts) {
    const keepItem = opts && opts.keepItem;
    const prevId = keepItem && items[activeIndex] ? items[activeIndex].id : null;
    const prevSheetId = currentSheetItem && currentSheetItem.id;
    el.feed.querySelectorAll(".card").forEach((card) => pauseVideo(card));

    items = list;
    liveSource = source;
    if (!items.length) {
      closeSheet();
      el.feed.innerHTML = '<div class="empty"><h2>لا توجد أخبار حالياً</h2><p>تعذّر قراءة الموجز. حاول لاحقاً.</p></div>';
      setStatus(source);
      return;
    }
    if (hinted) document.getElementById("app").classList.add("hint-hidden");
    el.feed.innerHTML = items.map((it, i) => renderCard(it, i, items.length)).join("");
    bindFeedOnce();
    setStatus(source);
    ensureSentinel();
    observeCards();

    let idx = 0;
    if (prevId != null) {
      const found = items.findIndex((it) => it.id === prevId);
      idx = found >= 0 ? found : 0;
    }
    setActive(idx);
    const card = el.feed.querySelector(`.card[data-index="${idx}"]`);
    if (card) card.scrollIntoView({ behavior: "auto", block: "start" });

    if (prevSheetId != null) {
      const still = items.find((it) => it.id === prevSheetId);
      if (!still) closeSheet();
      else openSheet(still);
    }
  }

  async function refreshFeed(opts) {
    if (fetching || loadingMore) return;
    fetching = true;
    try {
      let result;
      try {
        result = await fetchWpPage(1);
      } catch (_) {
        result = null;
      }
      if (!result || !result.items.length) {
        if (!items.length) {
          const live = await fetchLive();
          lastFetchAt = Date.now();
          if (live.source !== "snapshot" || !items.length) paint(live.items, live.source);
        }
        return;
      }
      lastFetchAt = Date.now();
      const freshIds = new Set(result.items.map((it) => it.id));
      const disappeared = page1Ids.filter((id) => !freshIds.has(id));
      const shifted = disappeared.length ? await fetchWpByIds(disappeared) : [];
      const shiftedIds = new Set(shifted.map((it) => it.id));
      const later = items.filter(
        (it) => !freshIds.has(it.id) && !page1Ids.includes(it.id) && !shiftedIds.has(it.id)
      );
      const merged = dedupeById(result.items.concat(shifted, later));
      const loadedPages = currentPage;
      markPagingFromPage1(result);
      if (loadedPages > 1) {
        currentPage = loadedPages;
        reachedEnd = currentPage >= totalPages;
      }
      if (listsEqual(items, merged) && liveSource === "live") {
        setStatus("live");
        ensureSentinel();
        return;
      }
      paint(merged, "live", { keepItem: true });
      if (opts && opts.notify) showToast("تم تحديث الموجز");
    } catch (_) {
      /* أبقِ القائمة الحالية إن فشل التحديث */
    } finally {
      fetching = false;
    }
  }

  el.sheetBackdrop.addEventListener("click", closeSheet);
  document.getElementById("sheet-close").addEventListener("click", closeSheet);
  document.getElementById("about-btn").addEventListener("click", () => {
    el.about.classList.remove("hidden");
  });
  document.getElementById("about-close").addEventListener("click", () => {
    el.about.classList.add("hidden");
  });
  el.about.addEventListener("click", (e) => {
    if (e.target === el.about) el.about.classList.add("hidden");
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }

  function maybeRefreshFromForeground() {
    if (document.visibilityState !== "visible") return;
    if (!lastFetchAt || Date.now() - lastFetchAt < REFRESH_AFTER_MS) return;
    refreshFeed({ notify: true });
  }

  document.addEventListener("visibilitychange", maybeRefreshFromForeground);
  window.addEventListener("focus", maybeRefreshFromForeground);
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) maybeRefreshFromForeground();
  });

  (async function init() {
    try {
      const live = await fetchLive();
      lastFetchAt = Date.now();
      paint(live.items, live.source);
    } catch (_) {
      lastFetchAt = Date.now();
      paint(snapshot().items || [], "snapshot");
    }
    el.loader.classList.add("hidden");
  })();
})();
