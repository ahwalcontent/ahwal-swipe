/*!
 * جميع الحقوق محفوظة © 2026 صحيفة أحوال الإلكترونية — عبدالله بن صالح بن خميس الكناني
 * يُمنع نسخ هذا البرنامج أو إعادة استخدامه أو توزيعه دون إذن كتابي من المالك.
 */
/* أحوال — لوحة المحررين: إنشاء وتعديل ونشر المحتوى في ahwal.sa مباشرة عبر واجهة ووردبريس
   (كلمات مرور التطبيقات). الموقع هو المصدر الوحيد للمحتوى، والصلاحيات نفس صلاحيات الموقع. */
(function () {
  "use strict";

  const SITE = "https://ahwal.sa";
  const API = SITE + "/wp-json/wp/v2";
  const APP_NAME = "تطبيق أحوال — لوحة المحررين";
  const APP_ID = "5b1f6a64-8f0e-4c55-9c1e-a4a0a7d2e311";
  const STORE_KEY = "ahwal-editor-auth";
  const TZ = "Asia/Riyadh";
  const PAGE_SIZE = 20;
  const MAX_IMAGE_EDGE = 2000;

  // 1) التقاط بيانات الموافقة من رابط العودة ثم حذفها من شريط العنوان فوراً
  const params = new URLSearchParams(location.search);
  let returnNotice = null;
  if (params.has("user_login") && params.has("password")) {
    const siteUrl = params.get("site_url") || SITE;
    let okSite = false;
    try { okSite = /(^|\.)ahwal\.sa$/i.test(new URL(siteUrl).hostname); } catch (e) { okSite = false; }
    if (okSite) {
      saveAuth({ user: params.get("user_login"), pass: params.get("password") });
    } else {
      returnNotice = { type: "error", text: "رابط العودة لا يخص موقع أحوال، لذلك لم يُحفظ." };
    }
  } else if (params.get("auth") === "rejected" || params.get("success") === "false") {
    returnNotice = { type: "info", text: "تم إلغاء الربط من صفحة الموقع. يمكنك المحاولة مرة أخرى متى شئت." };
  }
  if (location.search) history.replaceState(null, "", location.pathname + location.hash);

  const $ = (id) => document.getElementById(id);
  const views = ["login", "list", "form", "loading"];
  const state = {
    auth: loadAuth(),
    me: null,
    caps: {},
    cats: [],
    status: "any",
    allAuthors: false,
    page: 1,
    totalPages: 1,
    post: null,           // المقال الجاري تعديله (من الخادم) أو null للجديد
    selectedCats: new Set(),
    featured: null,       // { id, url }
    localImage: null,     // رابط معاينة محلي أثناء الرفع
    uploading: false,
    dirty: false,
    busy: false,
  };

  // ———————————————————— أدوات عامة ————————————————————
  function loadAuth() {
    try { const a = JSON.parse(localStorage.getItem(STORE_KEY) || "null"); return a && a.user && a.pass ? a : null; }
    catch (e) { return null; }
  }
  function saveAuth(a) { localStorage.setItem(STORE_KEY, JSON.stringify({ user: a.user, pass: a.pass })); }
  function clearAuth() { localStorage.removeItem(STORE_KEY); }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function decodeEntities(s) {
    const t = document.createElement("textarea"); t.innerHTML = s || ""; return t.value;
  }
  function stripHtml(html) {
    const d = document.createElement("div"); d.innerHTML = html || "";
    return (d.textContent || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }
  function fmtDate(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    try {
      return new Intl.DateTimeFormat("ar-SA", { timeZone: TZ, day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(d);
    } catch (e) { return d.toLocaleString("ar"); }
  }
  function gmtIso(p, key) {
    const v = p && p[key + "_gmt"];
    return v ? v.replace(" ", "T") + (v.endsWith("Z") ? "" : "Z") : (p && p[key]) || "";
  }
  const STATUS_AR = { publish: "منشور", draft: "مسودة", pending: "قيد المراجعة", future: "مجدول", private: "خاص", trash: "في المهملات", "auto-draft": "مسودة" };

  let toastTimer;
  function toast(msg) {
    const t = $("toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), 3200);
  }
  function showAlert(id, text, type, extraHtml) {
    const el = $(id);
    if (!text) { el.classList.add("hidden"); el.innerHTML = ""; return; }
    el.classList.toggle("is-info", type === "info");
    el.innerHTML = escapeHtml(text) + (extraHtml || "");
    el.classList.remove("hidden");
  }
  function show(view) {
    views.forEach((v) => { $("view-" + v).hidden = v !== view; });
    window.scrollTo(0, 0);
  }

  // ———————————————————— الاتصال بواجهة ووردبريس ————————————————————
  class ApiError extends Error {
    constructor(code, message, status) { super(message || code); this.code = code; this.status = status || 0; }
  }

  function authHeader() {
    if (!state.auth) return {};
    const raw = state.auth.user + ":" + state.auth.pass.replace(/\s+/g, " ").trim();
    const b64 = btoa(String.fromCharCode.apply(null, Array.from(new TextEncoder().encode(raw))));
    return { Authorization: "Basic " + b64 };
  }

  async function api(path, opts) {
    opts = opts || {};
    const url = (path.startsWith("http") ? path : API + path);
    const headers = Object.assign({ Accept: "application/json" }, authHeader(), opts.headers || {});
    let body = opts.body;
    if (body && !(body instanceof Blob) && typeof body === "object") {
      headers["Content-Type"] = "application/json; charset=utf-8";
      body = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(url, { method: opts.method || "GET", headers, body, cache: "no-store", credentials: "omit", mode: "cors" });
    } catch (e) {
      throw new ApiError("network", "", 0);
    }
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (!res.ok) {
      throw new ApiError((data && data.code) || "http_" + res.status, data && data.message, res.status);
    }
    return { data, headers: res.headers };
  }

  function uploadMedia(blob, filename, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", API + "/media");
      const h = authHeader();
      Object.keys(h).forEach((k) => xhr.setRequestHeader(k, h[k]));
      xhr.setRequestHeader("Content-Type", blob.type || "image/jpeg");
      xhr.setRequestHeader("Content-Disposition", 'attachment; filename="' + filename + '"');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onerror = () => reject(new ApiError("network", "", 0));
      xhr.onload = () => {
        let data = null; try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
        if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data);
        else reject(new ApiError((data && data.code) || "http_" + xhr.status, data && data.message, xhr.status));
      };
      xhr.send(blob);
    });
  }

  const AUTH_STRIPPED_MSG =
    "تم حفظ بيانات الربط، لكن خادم الموقع لا يمرّر بيانات الدخول إلى ووردبريس حالياً، فيظهر الطلب وكأنك غير مسجّل. " +
    "يلزم تعديل بسيط من مسؤول الموقع (سطر في ملف htaccess). بعد التعديل اضغط «إعادة المحاولة».";

  function errMsg(err) {
    if (!(err instanceof ApiError)) return "حدث خطأ غير متوقع. حاول مرة أخرى.";
    const c = err.code;
    if (c === "network") return "تعذّر الاتصال بموقع أحوال. تأكد من اتصالك بالإنترنت ثم حاول مرة أخرى.";
    if (c === "rest_not_logged_in") return AUTH_STRIPPED_MSG;
    if (/^(invalid_username|incorrect_password|invalid_email|application_passwords_disabled|application_passwords_disabled_for_user|empty_username|empty_password)$/.test(c))
      return "بيانات الدخول غير صحيحة أو أُلغيت كلمة مرور التطبيق من الموقع. سجّل الدخول من جديد.";
    if (c === "rest_cannot_publish") return "صلاحيتك لا تسمح بالنشر المباشر. أرسل الخبر للمراجعة.";
    if (c === "rest_cannot_create") return "صلاحيتك في الموقع لا تسمح بإنشاء مقالات.";
    if (c === "rest_cannot_edit" || c === "rest_cannot_edit_others") return "لا تملك صلاحية تعديل هذا المقال.";
    if (c === "rest_cannot_delete") return "لا تملك صلاحية حذف هذا المقال.";
    if (c === "rest_cannot_assign_term") return "لا تملك صلاحية استخدام هذا التصنيف أو الوسم.";
    if (c === "rest_cannot_create_term") return "لا تملك صلاحية إنشاء وسوم جديدة.";
    if (c === "rest_post_invalid_id" || err.status === 404) return "المقال غير موجود، ربما حُذف من الموقع.";
    if (c === "rest_already_trashed") return "المقال موجود في المهملات مسبقاً.";
    if (/^rest_upload_/.test(c) || c === "rest_cannot_create_media") {
      if (c === "rest_cannot_create_media" || err.status === 403) return "صلاحيتك لا تسمح برفع الصور.";
      return "تعذّر رفع الصورة." + (err.message ? " (" + stripHtml(err.message) + ")" : "");
    }
    if (err.status === 413) return "حجم الملف أكبر من المسموح في الموقع. جرّب صورة أصغر.";
    if (err.status === 403) return "الطلب مرفوض من الموقع (ممنوع). قد يكون جدار الحماية أو صلاحيتك.";
    if (err.status === 401) return "انتهت صلاحية الدخول. سجّل الدخول من جديد.";
    if (err.status >= 500) return "حدث خطأ في خادم الموقع. حاول بعد قليل.";
    return err.message ? stripHtml(err.message) : "تعذّر تنفيذ الطلب.";
  }
  function isAuthFailure(err) {
    return err instanceof ApiError && /^(invalid_username|incorrect_password|invalid_email|application_passwords_disabled|application_passwords_disabled_for_user)$/.test(err.code);
  }

  // ———————————————————— الدخول ————————————————————
  function authorizeUrl() {
    const here = location.origin + location.pathname;
    const q = new URLSearchParams({ app_name: APP_NAME, app_id: APP_ID, success_url: here, reject_url: here + "?auth=rejected" });
    return SITE + "/wp-admin/authorize-application.php?" + q.toString();
  }

  async function connect() {
    if (!state.auth) { renderLogin(); return; }
    show("loading");
    try {
      const { data } = await api("/users/me?context=edit");
      state.me = data;
      state.caps = data.capabilities || {};
      if (!state.caps.edit_posts) {
        renderLogin({ type: "error", text: "حسابك (" + (data.name || state.auth.user) + ") لا يملك صلاحية كتابة المقالات في الموقع. تواصل مع إدارة الصحيفة." });
        return;
      }
      $("who").textContent = data.name || state.auth.user;
      $("who").classList.remove("hidden");
      $("logout-btn").classList.remove("hidden");
      $("all-authors-wrap").classList.toggle("hidden", !state.caps.edit_others_posts);
      loadCategories();
      openList();
    } catch (err) {
      if (isAuthFailure(err)) { clearAuth(); state.auth = null; }
      const retry = state.auth ? ' <button class="ed-btn ed-btn-ghost ed-btn-sm" type="button" id="retry-btn">إعادة المحاولة</button>' : "";
      renderLogin({ type: err.code === "rest_not_logged_in" ? "info" : "error", text: errMsg(err), extra: retry });
    }
  }

  function renderLogin(notice) {
    show("login");
    $("who").classList.add("hidden");
    $("logout-btn").classList.toggle("hidden", !state.auth);
    if (notice) showAlert("login-error", notice.text, notice.type, notice.extra);
    else showAlert("login-error", "");
    const r = document.getElementById("retry-btn");
    if (r) r.addEventListener("click", connect);
  }

  function logout() {
    confirmBox("تسجيل الخروج", "سيُحذف ربط حسابك من هذا الجهاز. لإلغاء كلمة مرور التطبيق نهائياً افتح ملفك الشخصي في الموقع ← «كلمات مرور التطبيقات».", "تسجيل الخروج").then((ok) => {
      if (!ok) return;
      clearAuth(); state.auth = null; state.me = null; state.caps = {};
      renderLogin({ type: "info", text: "تم تسجيل الخروج من هذا الجهاز.", extra: ' <a href="' + SITE + '/wp-admin/profile.php#application-passwords-section" target="_blank" rel="noopener">إدارة كلمات مرور التطبيقات</a>' });
    });
  }

  // ———————————————————— التصنيفات ————————————————————
  async function loadCategories() {
    try {
      let page = 1, all = [], total = 1;
      do {
        const { data, headers } = await api("/categories?per_page=100&orderby=count&order=desc&hide_empty=false&_fields=id,name,parent,count&page=" + page);
        all = all.concat(data || []);
        total = parseInt(headers.get("X-WP-TotalPages") || "1", 10);
        page++;
      } while (page <= total && page <= 5);
      state.cats = all.map((c) => ({ id: c.id, name: decodeEntities(c.name), count: c.count }));
      renderCats();
    } catch (err) { /* تبقى القائمة فارغة وتظهر رسالة عند الحفظ */ }
  }
  function catName(id) { const c = state.cats.find((x) => x.id === id); return c ? c.name : ""; }
  function renderCats() {
    const q = ($("cat-search").value || "").trim();
    const list = state.cats.filter((c) => !q || c.name.includes(q) || state.selectedCats.has(c.id));
    list.sort((a, b) => (state.selectedCats.has(b.id) ? 1 : 0) - (state.selectedCats.has(a.id) ? 1 : 0));
    $("f-cats").innerHTML = list.length
      ? list.map((c) => `<button type="button" class="ed-chip${state.selectedCats.has(c.id) ? " is-on" : ""}" data-cat="${c.id}">${escapeHtml(c.name)}</button>`).join("")
      : '<span class="ed-hint">لا توجد تصنيفات مطابقة</span>';
  }

  // ———————————————————— قائمة المقالات ————————————————————
  function listUrl(page) {
    const statuses = state.status === "any"
      ? ["draft", "pending", "future", "publish"].concat(state.caps.read_private_posts ? ["private"] : [])
      : [state.status];
    const q = new URLSearchParams({
      context: "edit", per_page: String(PAGE_SIZE), page: String(page), orderby: "modified", order: "desc",
      status: statuses.join(","), _embed: "wp:featuredmedia",
    });
    if (!state.allAuthors || !state.caps.edit_others_posts) q.set("author", String(state.me.id));
    return "/posts?" + q.toString();
  }

  function thumbOf(p) {
    const m = p._embedded && p._embedded["wp:featuredmedia"] && p._embedded["wp:featuredmedia"][0];
    if (!m || m.code) return "";
    const s = (m.media_details && m.media_details.sizes) || {};
    for (const k of ["thumbnail", "medium", "medium_large", "large"]) if (s[k] && s[k].source_url) return s[k].source_url;
    return m.source_url || "";
  }
  function bigImageOf(m) {
    if (!m) return "";
    const s = (m.media_details && m.media_details.sizes) || {};
    for (const k of ["large", "medium_large", "full"]) if (s[k] && s[k].source_url) return s[k].source_url;
    return m.source_url || "";
  }

  function postItem(p) {
    const title = decodeEntities((p.title && (p.title.raw || p.title.rendered)) || "") || "(بدون عنوان)";
    const th = thumbOf(p);
    const cat = (p.categories || []).map(catName).filter(Boolean)[0] || "";
    return `<li><button type="button" class="ed-post" data-edit="${p.id}">
      <div class="ed-thumb">${th ? `<img src="${escapeHtml(th)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ""}</div>
      <div class="ed-post-body">
        <div class="ed-post-title">${escapeHtml(title)}</div>
        <div class="ed-post-meta">
          <span class="ed-status-chip st-${escapeHtml(p.status)}">${escapeHtml(STATUS_AR[p.status] || p.status)}</span>
          ${cat ? `<span>${escapeHtml(cat)}</span>` : ""}
          <time>${escapeHtml(fmtDate(gmtIso(p, "modified")))}</time>
        </div>
      </div>
    </button></li>`;
  }

  async function openList() {
    show("list");
    state.page = 1;
    $("posts").innerHTML = '<li class="ed-empty"><div class="ed-spinner" style="margin:10px auto"></div></li>';
    $("more-btn").classList.add("hidden");
    showAlert("list-error", "");
    await loadPage(1, true);
  }

  async function loadPage(page, replace) {
    try {
      const { data, headers } = await api(listUrl(page));
      state.totalPages = parseInt(headers.get("X-WP-TotalPages") || "1", 10);
      state.page = page;
      const html = (data || []).map(postItem).join("");
      if (replace) $("posts").innerHTML = html || '<li class="ed-empty">لا توجد مقالات هنا بعد. ابدأ بـ«مقال جديد».</li>';
      else $("posts").insertAdjacentHTML("beforeend", html);
      $("more-btn").classList.toggle("hidden", state.page >= state.totalPages);
    } catch (err) {
      if (replace) $("posts").innerHTML = "";
      showAlert("list-error", errMsg(err));
      if (isAuthFailure(err)) { clearAuth(); state.auth = null; renderLogin({ type: "error", text: errMsg(err) }); }
    }
  }

  // ———————————————————— الصلاحيات ————————————————————
  function isOwn(p) { return !p || p.author === state.me.id; }
  function isLive(p) { return p && (p.status === "publish" || p.status === "future" || p.status === "private"); }
  function canEdit(p) {
    if (!p) return !!state.caps.edit_posts;
    if (!isOwn(p) && !state.caps.edit_others_posts) return false;
    if (isLive(p) && !state.caps.edit_published_posts) return false;
    return !!state.caps.edit_posts;
  }
  function canTrash(p) {
    if (!p) return false;
    if (!isOwn(p) && !state.caps.delete_others_posts) return false;
    if (isLive(p)) return !!state.caps.delete_published_posts;
    return !!state.caps.delete_posts;
  }
  function roleLabel() {
    const r = (state.me && state.me.roles) || [];
    const map = { administrator: "مدير", editor: "محرر", author: "كاتب", contributor: "مساهم" };
    return r.map((x) => map[x] || x).join("، ");
  }

  function applyButtons() {
    const p = state.post;
    const editable = canEdit(p);
    const pub = !!state.caps.publish_posts;
    const live = isLive(p);
    const set = (id, visible, label) => { const b = $(id); b.classList.toggle("hidden", !visible); if (label) b.textContent = label; };
    set("btn-draft", editable, live ? "إرجاع إلى مسودة" : "حفظ مسودة");
    set("btn-pending", editable && !pub && !live, p && p.status === "pending" ? "تحديث (قيد المراجعة)" : "إرسال للمراجعة");
    set("btn-publish", editable && pub, live ? "تحديث المنشور" : p && p.status === "pending" ? "اعتماد ونشر" : "نشر");
    set("btn-trash", canTrash(p));
    const noUpload = !state.caps.upload_files;
    $("media-actions").classList.toggle("hidden", noUpload || !editable);
    $("media-nocap").classList.toggle("hidden", !noUpload);
    $("form-status").className = "ed-status-chip" + (p ? " st-" + p.status : "");
    $("form-status").textContent = p ? STATUS_AR[p.status] || p.status : "جديد";
    let hint = "صلاحيتك: " + roleLabel() + ". ";
    if (!editable) hint += "هذا المقال للعرض فقط حسب صلاحيتك.";
    else if (!pub) hint += "ما تكتبه يُرسل للمراجعة، وينشره المحرر بعد الاعتماد.";
    else hint += "يمكنك النشر مباشرة، ويظهر الخبر في الموقع والتطبيق فوراً.";
    $("role-hint").textContent = hint;
    ["f-title", "f-excerpt", "f-tags", "f-video", "cat-search", "f-seo-title", "f-seo-desc", "f-seo-focus"].forEach((id) => { $(id).disabled = !editable; });
    $("f-body").contentEditable = editable ? "true" : "false";
  }

  // ———————————————————— النموذج ————————————————————
  const EMBED_RE = /<!--\s*wp:embed\s+(\{[\s\S]*?\})\s*-->[\s\S]*?<!--\s*\/wp:embed\s*-->/;

  function splitVideo(raw) {
    const m = (raw || "").match(EMBED_RE);
    if (!m) return { html: raw || "", video: "" };
    let url = "";
    try { url = JSON.parse(m[1]).url || ""; } catch (e) { url = ""; }
    return { html: (raw || "").replace(m[0], "").trim(), video: url };
  }
  function autop(raw) {
    if (/<(p|h[1-6]|ul|ol|blockquote|figure|div|table)[\s>]/i.test(raw)) return raw;
    return raw.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean).map((b) => "<p>" + b.replace(/\n/g, "<br>") + "</p>").join("");
  }
  function videoProvider(url) {
    try {
      const h = new URL(url).hostname.replace(/^www\.|^m\./, "");
      if (/youtube\.com$|youtu\.be$/.test(h)) return "youtube";
      if (/vimeo\.com$/.test(h)) return "vimeo";
      if (/tiktok\.com$/.test(h)) return "tiktok";
      if (/(twitter|x)\.com$/.test(h)) return "twitter";
      if (/instagram\.com$/.test(h)) return "instagram";
      return h.split(".")[0];
    } catch (e) { return ""; }
  }
  function youtubeId(url) {
    const m = (url || "").match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
    return m ? m[1] : "";
  }
  function embedBlock(url) {
    const prov = videoProvider(url);
    const type = /^(youtube|vimeo|tiktok)$/.test(prov) ? "video" : "rich";
    const attrs = JSON.stringify({ url, type, providerNameSlug: prov, responsive: true });
    const cls = "wp-block-embed is-type-" + type + " is-provider-" + prov + " wp-block-embed-" + prov;
    return `<!-- wp:embed ${attrs} -->\n<figure class="${cls}"><div class="wp-block-embed__wrapper">\n${url}\n</div></figure>\n<!-- /wp:embed -->`;
  }

  function cleanBody() {
    const d = document.createElement("div");
    d.innerHTML = $("f-body").innerHTML;
    d.querySelectorAll("div").forEach((n) => { const p = document.createElement("p"); p.innerHTML = n.innerHTML; n.replaceWith(p); });
    d.querySelectorAll("[style]").forEach((n) => n.removeAttribute("style"));
    d.querySelectorAll("span").forEach((n) => n.replaceWith(...n.childNodes));
    d.querySelectorAll("p").forEach((n) => { if (!n.textContent.trim() && !n.querySelector("img,iframe")) n.remove(); });
    return d.innerHTML.trim();
  }


  const SEO_DESC_MIN = 120;
  const SEO_DESC_MAX = 156;
  function updateSeoCount() {
    const el = $("seo-desc-count");
    if (!el) return;
    const n = ($("f-seo-desc").value || "").trim().length;
    el.textContent = n + " / " + SEO_DESC_MAX;
    el.classList.remove("is-short", "is-ok", "is-long");
    if (!n) return;
    if (n < SEO_DESC_MIN) el.classList.add("is-short");
    else if (n <= SEO_DESC_MAX) el.classList.add("is-ok");
    else el.classList.add("is-long");
  }

  function yoastMetaFromForm() {
    return {
      _yoast_wpseo_title: $("f-seo-title").value.trim(),
      _yoast_wpseo_metadesc: $("f-seo-desc").value.trim(),
      _yoast_wpseo_focuskw: $("f-seo-focus").value.trim(),
    };
  }

  function fillYoast(p) {
    const meta = (p && p.meta && typeof p.meta === "object") ? p.meta : {};
    $("f-seo-title").value = meta._yoast_wpseo_title || "";
    $("f-seo-desc").value = meta._yoast_wpseo_metadesc || "";
    $("f-seo-focus").value = meta._yoast_wpseo_focuskw || "";
    updateSeoCount();
    $("yoast-warn").classList.add("hidden");
  }

  function isMetaRejected(err) {
    if (!(err instanceof ApiError)) return false;
    if (err.code === "rest_invalid_param") return true;
    const msg = (err.message || "").toLowerCase();
    return err.status === 400 && /\bmeta\b/.test(msg);
  }

  function resetForm() {
    $("post-form").reset();
    $("f-body").innerHTML = "";
    state.selectedCats = new Set();
    state.featured = null;
    state.localImage = null;
    showAlert("form-error", "");
    setMediaPreview("");
    $("cat-search").value = "";
    fillYoast(null);
  }

  function openNew() {
    state.post = null;
    resetForm();
    renderCats();
    applyButtons();
    show("form");
    state.dirty = false;
    renderPreview();
    $("f-title").focus();
  }

  async function openEdit(id) {
    show("loading");
    try {
      const { data: p } = await api("/posts/" + id + "?context=edit&_embed=wp:featuredmedia,wp:term");
      state.post = p;
      resetForm();
      $("f-title").value = decodeEntities(p.title.raw || p.title.rendered || "");
      $("f-excerpt").value = decodeEntities(p.excerpt.raw != null ? p.excerpt.raw : stripHtml(p.excerpt.rendered));
      const sv = splitVideo(p.content.raw != null ? p.content.raw : p.content.rendered);
      $("f-body").innerHTML = autop(sv.html);
      $("f-video").value = sv.video;
      state.selectedCats = new Set(p.categories || []);
      const terms = (p._embedded && p._embedded["wp:term"]) || [];
      const tags = (terms.find((g) => g && g[0] && g[0].taxonomy === "post_tag") || []).map((t) => decodeEntities(t.name));
      $("f-tags").value = tags.join("، ");
      const media = p._embedded && p._embedded["wp:featuredmedia"] && p._embedded["wp:featuredmedia"][0];
      if (p.featured_media && media && !media.code) state.featured = { id: p.featured_media, url: bigImageOf(media) };
      else if (p.featured_media) state.featured = { id: p.featured_media, url: "" };
      setMediaPreview(state.featured && state.featured.url);
      fillYoast(p);
      renderCats();
      applyButtons();
      show("form");
      state.dirty = false;
      renderPreview();
    } catch (err) {
      openList();
      showAlert("list-error", errMsg(err));
    }
  }

  function setMediaPreview(url) {
    const box = $("media-preview");
    if (url) { box.classList.remove("is-empty"); box.innerHTML = `<img src="${escapeHtml(url)}" alt="" referrerpolicy="no-referrer">`; }
    else { box.classList.add("is-empty"); box.innerHTML = "<span>لا توجد صورة</span>"; }
    $("media-remove").classList.toggle("hidden", !url && !(state.featured && state.featured.id));
  }

  async function shrinkImage(file) {
    if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type) && file.type) return file;
    try {
      const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bmp.width, bmp.height));
      if (scale === 1 && file.size < 1.5 * 1024 * 1024 && /jpeg|png|webp/i.test(file.type)) return file;
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
      c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.86));
      return blob && blob.size < file.size * 1.2 ? blob : file;
    } catch (e) { return file; }
  }

  async function handleFile(file) {
    if (!file) return;
    if (!/^image\//.test(file.type || "image/")) { showAlert("form-error", "الملف المختار ليس صورة."); return; }
    showAlert("form-error", "");
    state.uploading = true;
    state.localImage = URL.createObjectURL(file);
    setMediaPreview(state.localImage);
    renderPreview();
    const bar = $("media-progress");
    bar.classList.remove("hidden"); bar.firstElementChild.style.width = "4%";
    try {
      const blob = await shrinkImage(file);
      const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : "jpg";
      const media = await uploadMedia(blob, "ahwal-" + Date.now() + "." + ext, (f) => { bar.firstElementChild.style.width = Math.max(4, Math.round(f * 100)) + "%"; });
      state.featured = { id: media.id, url: bigImageOf(media) || media.source_url };
      state.dirty = true;
      toast("تم رفع الصورة ✓");
      const alt = $("f-title").value.trim();
      if (alt) api("/media/" + media.id, { method: "POST", body: { alt_text: alt } }).catch(() => {});
    } catch (err) {
      state.localImage = null;
      setMediaPreview(state.featured && state.featured.url);
      showAlert("form-error", errMsg(err));
    } finally {
      state.uploading = false;
      bar.classList.add("hidden");
      renderPreview();
    }
  }

  async function resolveTags() {
    const names = ($("f-tags").value || "").split(/[,،]/).map((s) => s.trim()).filter(Boolean);
    const ids = [], skipped = [];
    for (const name of Array.from(new Set(names)).slice(0, 15)) {
      try {
        const { data } = await api("/tags?per_page=20&_fields=id,name&search=" + encodeURIComponent(name));
        const hit = (data || []).find((t) => decodeEntities(t.name).trim() === name);
        if (hit) { ids.push(hit.id); continue; }
        if (!state.caps.manage_categories) { skipped.push(name); continue; }
        const { data: created } = await api("/tags", { method: "POST", body: { name } });
        if (created && created.id) ids.push(created.id); else skipped.push(name);
      } catch (err) {
        const existing = err.code === "term_exists" && err.data && err.data.term_id;
        if (existing) ids.push(existing); else skipped.push(name);
      }
    }
    return { ids, skipped };
  }

  async function save(status) {
    if (state.busy) return;
    showAlert("form-error", "");
    const title = $("f-title").value.trim();
    const body = cleanBody();
    const video = $("f-video").value.trim();
    if (!title) { showAlert("form-error", "اكتب عنوان الخبر أولاً."); $("f-title").focus(); return; }
    if (status !== "draft" && !body && !video) { showAlert("form-error", "نص الخبر فارغ. اكتب النص أو أضف رابط فيديو."); return; }
    if (video && !/^https:\/\/\S+$/i.test(video)) { showAlert("form-error", "رابط الفيديو غير صحيح. يجب أن يبدأ بـ https://"); return; }
    if (state.uploading) { showAlert("form-error", "انتظر حتى يكتمل رفع الصورة."); return; }
    if (status === "publish" && !state.caps.publish_posts) status = "pending";
    if (status === "publish" && !isLive(state.post)) {
      const ok = await confirmBox("نشر الخبر", "سيظهر الخبر فوراً في موقع أحوال والتطبيق. هل تريد النشر الآن؟", "نشر الآن", true);
      if (!ok) return;
    }
    state.busy = true;
    setButtonsBusy(true);
    try {
      const tags = await resolveTags();
      const payload = {
        title,
        excerpt: $("f-excerpt").value.trim(),
        content: body + (video ? "\n\n" + embedBlock(video) : ""),
        status: isLive(state.post) && status === "publish" ? state.post.status : status,
        categories: Array.from(state.selectedCats),
        tags: tags.ids,
        featured_media: state.featured ? state.featured.id : 0,
        meta: yoastMetaFromForm(),
      };
      const path = state.post ? "/posts/" + state.post.id : "/posts";
      let saved;
      let yoastSkipped = false;
      try {
        saved = (await api(path, { method: "POST", body: payload })).data;
      } catch (err) {
        if (!isMetaRejected(err)) throw err;
        delete payload.meta;
        saved = (await api(path, { method: "POST", body: payload })).data;
        yoastSkipped = true;
        $("yoast-warn").classList.remove("hidden");
      }
      state.post = saved;
      state.dirty = false;
      if (!yoastSkipped) $("yoast-warn").classList.add("hidden");
      const msg = { publish: "تم النشر ✓", future: "تمت الجدولة ✓", pending: "أُرسل للمراجعة ✓", draft: "حُفظت المسودة ✓", private: "تم الحفظ ✓" }[saved.status] || "تم الحفظ ✓";
      let note = tags.skipped.length ? msg + " — لم تُضف وسوم جديدة: " + tags.skipped.join("، ") : msg;
      if (yoastSkipped) note += " — حقول Yoast لم تُحفظ (حدّث إضافة الموقع إلى 1.0.3).";
      toast(note);
      applyButtons();
      if (saved.status === "publish") setTimeout(openList, 900);
    } catch (err) {
      showAlert("form-error", errMsg(err));
    } finally {
      state.busy = false;
      setButtonsBusy(false);
    }
  }

  function setButtonsBusy(b) { $("form-actions").querySelectorAll("button").forEach((x) => { x.disabled = b; }); }

  async function trash() {
    const p = state.post; if (!p) return;
    const ok = await confirmBox("نقل إلى المهملات", "سيُنقل «" + ($("f-title").value || "هذا المقال") + "» إلى سلة المهملات في الموقع" + (isLive(p) ? " ويختفي من الموقع والتطبيق" : "") + ". يمكن استرجاعه من لوحة ووردبريس خلال ٣٠ يوماً.", "نقل إلى المهملات");
    if (!ok) return;
    setButtonsBusy(true);
    try {
      await api("/posts/" + p.id, { method: "DELETE" });
      state.dirty = false;
      toast("نُقل إلى المهملات");
      openList();
    } catch (err) { showAlert("form-error", errMsg(err)); }
    finally { setButtonsBusy(false); }
  }

  // ———————————————————— المعاينة ————————————————————
  function renderPreview() {
    const title = $("f-title").value.trim() || "عنوان الخبر يظهر هنا";
    let excerpt = $("f-excerpt").value.trim();
    if (!excerpt) { const t = stripHtml($("f-body").innerHTML); excerpt = t.slice(0, 180) + (t.length > 180 ? "…" : ""); }
    const cat = Array.from(state.selectedCats).map(catName).filter(Boolean)[0] || "أحوال";
    const img = state.localImage || (state.featured && state.featured.url) || "";
    const vid = $("f-video").value.trim();
    const yt = youtubeId(vid);
    const date = state.post && isLive(state.post) ? gmtIso(state.post, "date") : new Date().toISOString();
    const author = (state.me && state.me.name) || "";
    const st = state.post ? state.post.status : "draft";
    $("preview").innerHTML = `<article class="pv-card">
      <div class="pv-bg">${img ? `<img src="${escapeHtml(img)}" alt="" referrerpolicy="no-referrer">` : ""}<div class="pv-shade"></div></div>
      <div class="pv-logo"><img src="assets/logo-site.png" alt=""></div>
      ${st !== "publish" ? `<span class="pv-draft">${escapeHtml(STATUS_AR[st] || "مسودة")} — غير منشور</span>` : ""}
      ${vid ? `<div class="pv-video"><div class="pv-video-frame">${yt ? `<img src="https://i.ytimg.com/vi/${escapeHtml(yt)}/hqdefault.jpg" alt="" onerror="this.remove()">` : img ? `<img src="${escapeHtml(img)}" alt="">` : ""}<span class="pv-play"></span></div></div>` : ""}
      <div class="pv-body">
        <span class="pv-cat${vid ? " is-video" : ""}">${escapeHtml(vid ? "فيديو · " + cat : cat)}</span>
        <h2>${escapeHtml(title)}</h2>
        <div class="pv-meta"><time>${escapeHtml(fmtDate(date))}</time>${author ? `<span>${escapeHtml(author)}</span>` : ""}</div>
        ${excerpt ? `<p class="pv-excerpt">${escapeHtml(excerpt)}</p>` : ""}
        <div class="pv-actions"><span>اقرأ المزيد</span><span class="g"></span><span class="g"></span></div>
      </div>
    </article>`;
  }
  let pvTimer;
  function schedulePreview() { state.dirty = true; clearTimeout(pvTimer); pvTimer = setTimeout(renderPreview, 250); }

  // ———————————————————— نافذة التأكيد ————————————————————
  function confirmBox(title, text, yesLabel, primary) {
    return new Promise((resolve) => {
      $("confirm-title").textContent = title;
      $("confirm-text").textContent = text;
      const yes = $("confirm-yes"), no = $("confirm-no");
      yes.textContent = yesLabel || "تأكيد";
      yes.className = "ed-btn " + (primary ? "ed-btn-primary" : "ed-btn-danger");
      $("confirm").classList.remove("hidden");
      const done = (v) => { $("confirm").classList.add("hidden"); yes.onclick = no.onclick = null; resolve(v); };
      yes.onclick = () => done(true);
      no.onclick = () => done(false);
    });
  }

  // ———————————————————— محرر النص ————————————————————
  let savedRange = null;
  function keepSelection() {
    const s = window.getSelection();
    if (s.rangeCount && $("f-body").contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
  }
  function restoreSelection() {
    $("f-body").focus();
    if (savedRange) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
  }
  function runCmd(cmd) {
    restoreSelection();
    const block = (tag) => {
      const cur = (document.queryCommandValue("formatBlock") || "").toLowerCase();
      document.execCommand("formatBlock", false, cur === tag ? "p" : tag);
    };
    switch (cmd) {
      case "bold": document.execCommand("bold"); break;
      case "italic": document.execCommand("italic"); break;
      case "h2": block("h2"); break;
      case "h3": block("h3"); break;
      case "quote": block("blockquote"); break;
      case "ul": document.execCommand("insertUnorderedList"); break;
      case "ol": document.execCommand("insertOrderedList"); break;
      case "clear": document.execCommand("removeFormat"); document.execCommand("formatBlock", false, "p"); document.execCommand("unlink"); break;
      case "link":
        $("link-url").value = "https://";
        $("link-modal").classList.remove("hidden");
        setTimeout(() => $("link-url").focus(), 30);
        return;
    }
    keepSelection();
    schedulePreview();
  }

  // ———————————————————— الأحداث ————————————————————
  function bind() {
    $("connect-btn").addEventListener("click", () => { location.href = authorizeUrl(); });
    $("manual-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const user = $("m-user").value.trim(), pass = $("m-pass").value.trim();
      if (!user || !pass) return;
      state.auth = { user, pass };
      saveAuth(state.auth);
      $("m-pass").value = "";
      connect();
    });
    $("logout-btn").addEventListener("click", logout);
    $("new-btn").addEventListener("click", openNew);
    $("more-btn").addEventListener("click", () => loadPage(state.page + 1, false));
    $("tabs").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-status]"); if (!b) return;
      $("tabs").querySelectorAll("button").forEach((x) => x.classList.toggle("is-on", x === b));
      state.status = b.dataset.status;
      openList();
    });
    $("all-authors").addEventListener("change", (e) => { state.allAuthors = e.target.checked; openList(); });
    $("posts").addEventListener("click", (e) => { const b = e.target.closest("[data-edit]"); if (b) openEdit(parseInt(b.dataset.edit, 10)); });

    $("back-btn").addEventListener("click", async () => {
      if (state.dirty && !(await confirmBox("تغييرات غير محفوظة", "عندك تعديلات لم تُحفظ. تريد الخروج بدون حفظ؟", "خروج بدون حفظ"))) return;
      state.dirty = false;
      openList();
    });
    $("form-actions").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b) return;
      if (b.dataset.save) save(b.dataset.save);
      else if (b.id === "btn-trash") trash();
      else if (b.id === "btn-preview") { renderPreview(); $("preview-wrap").classList.add("is-open"); }
    });
    $("preview-close").addEventListener("click", () => $("preview-wrap").classList.remove("is-open"));

    $("f-cats").addEventListener("click", (e) => {
      const b = e.target.closest("[data-cat]"); if (!b || $("cat-search").disabled) return;
      const id = parseInt(b.dataset.cat, 10);
      if (state.selectedCats.has(id)) state.selectedCats.delete(id); else state.selectedCats.add(id);
      b.classList.toggle("is-on");
      schedulePreview();
    });
    $("cat-search").addEventListener("input", renderCats);
    ["f-title", "f-excerpt", "f-video", "f-tags"].forEach((id) => $(id).addEventListener("input", schedulePreview));
    $("f-seo-desc").addEventListener("input", updateSeoCount);
    ["f-seo-title", "f-seo-desc", "f-seo-focus"].forEach((id) => $(id).addEventListener("input", () => { state.dirty = true; }));

    const body = $("f-body");
    try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch (e) { /* قديم */ }
    body.addEventListener("input", schedulePreview);
    body.addEventListener("keyup", keepSelection);
    body.addEventListener("mouseup", keepSelection);
    body.addEventListener("touchend", keepSelection);
    body.addEventListener("paste", (e) => {
      e.preventDefault();
      const text = (e.clipboardData || window.clipboardData).getData("text/plain");
      const html = text.split(/\r?\n\s*\r?\n/).map((b) => "<p>" + escapeHtml(b.trim()).replace(/\r?\n/g, "<br>") + "</p>").join("");
      document.execCommand("insertHTML", false, html);
    });
    $("toolbar").addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
    $("toolbar").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-cmd]"); if (!b || body.contentEditable !== "true") return;
      runCmd(b.dataset.cmd);
    });
    $("link-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const url = $("link-url").value.trim();
      $("link-modal").classList.add("hidden");
      if (!/^https?:\/\/\S+$/i.test(url)) { toast("الرابط غير صحيح"); return; }
      restoreSelection();
      const sel = window.getSelection();
      if (sel.isCollapsed) document.execCommand("insertHTML", false, `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
      else document.execCommand("createLink", false, url);
      schedulePreview();
    });
    $("link-cancel").addEventListener("click", () => $("link-modal").classList.add("hidden"));

    const onFile = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; handleFile(f); };
    $("f-camera").addEventListener("change", onFile);
    $("f-gallery").addEventListener("change", onFile);
    $("media-remove").addEventListener("click", () => { state.featured = null; state.localImage = null; setMediaPreview(""); schedulePreview(); });

    window.addEventListener("beforeunload", (e) => { if (state.dirty && !$("view-form").hidden) { e.preventDefault(); e.returnValue = ""; } });
  }

  bind();
  if (returnNotice) renderLogin(returnNotice);
  if (state.auth) connect(); else if (!returnNotice) renderLogin();
})();
