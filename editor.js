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
    set("btn-schedule", editable && pub && (!live || p.status === "future"), p && p.status === "future" ? "تغيير الجدولة" : "جدولة");
    set("btn-site", true);
    set("btn-preview", true);
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
    ["f-title", "f-excerpt", "f-tags", "f-video", "cat-search", "f-seo-title", "f-seo-desc", "f-seo-focus", "f-city", "f-dateline", "dateline-auto",
      "f-slug", "f-canonical", "f-og-title", "f-og-desc", "f-tw-title", "f-tw-desc", "f-primary-cat", "f-noindex", "f-nofollow", "f-cornerstone"].forEach((id) => { $(id).disabled = !editable; });
    $("f-body").contentEditable = editable ? "true" : "false";
    $("toolbar").classList.toggle("is-disabled", !editable);
  }

  // ———————————————————— ثوابت المحتوى ————————————————————
  const SITE_NAME = "أحوال";
  const SEP = "|";
  const CITY_KEY = "ahwal-editor-city";
  const AUTOSAVE_PREFIX = "ahwal-editor-autosave:";
  const CITIES = ["واس", "الرياض", "جدة", "مكة المكرمة", "المدينة المنورة", "الدمام", "الخبر", "الظهران", "الأحساء", "القطيف", "الجبيل",
    "الطائف", "تبوك", "أبها", "خميس مشيط", "بريدة", "عنيزة", "الرس", "حائل", "جازان", "صبيا", "أبو عريش", "نجران", "شرورة", "الباحة",
    "سكاكا", "الجوف", "القريات", "عرعر", "رفحاء", "طريف", "حفر الباطن", "ينبع", "رابغ", "العلا", "الليث", "القنفذة", "بيشة", "محايل عسير",
    "النماص", "رجال ألمع", "الخرج", "المجمعة", "الزلفي", "شقراء", "الدوادمي", "وادي الدواسر", "الأفلاج", "ضباء", "الوجه", "أملج", "تيماء"];
  const YOAST_KEYS = ["_yoast_wpseo_title", "_yoast_wpseo_metadesc", "_yoast_wpseo_focuskw", "_yoast_wpseo_canonical",
    "_yoast_wpseo_meta-robots-noindex", "_yoast_wpseo_meta-robots-nofollow", "_yoast_wpseo_is_cornerstone",
    "_yoast_wpseo_opengraph-title", "_yoast_wpseo_opengraph-description", "_yoast_wpseo_opengraph-image", "_yoast_wpseo_opengraph-image-id",
    "_yoast_wpseo_twitter-title", "_yoast_wpseo_twitter-description", "_yoast_wpseo_twitter-image", "_yoast_wpseo_twitter-image-id",
    "_yoast_wpseo_primary_category"];
  const YOAST_BASIC = ["_yoast_wpseo_title", "_yoast_wpseo_metadesc", "_yoast_wpseo_focuskw"];

  // ———————————————————— الفيديو والتضمين ————————————————————
  const TRAIL_EMBED_RE = /<!--\s*wp:embed\s+(\{[\s\S]*?\})\s*-->[\s\S]*?<!--\s*\/wp:embed\s*-->\s*$/;
  const ANY_EMBED_RE = /<!--\s*wp:embed\s+(\{[\s\S]*?\})\s*-->[\s\S]*?<!--\s*\/wp:embed\s*-->/g;

  function splitVideo(raw) {
    raw = raw || "";
    const m = raw.match(TRAIL_EMBED_RE);
    if (!m) return { html: raw, video: "" };
    let url = "";
    try { url = JSON.parse(m[1]).url || ""; } catch (e) { url = ""; }
    return { html: raw.slice(0, m.index).trim(), video: url };
  }
  function videoProvider(url) {
    try {
      const h = new URL(url).hostname.replace(/^www\.|^m\.|^mobile\./, "");
      if (/youtube\.com$|youtu\.be$/.test(h)) return "youtube";
      if (/vimeo\.com$/.test(h)) return "vimeo";
      if (/tiktok\.com$/.test(h)) return "tiktok";
      if (/(^|\.)(twitter|x)\.com$/.test(h)) return "twitter";
      if (/instagram\.com$/.test(h)) return "instagram";
      if (/facebook\.com$|fb\.watch$/.test(h)) return "facebook";
      if (/soundcloud\.com$/.test(h)) return "soundcloud";
      if (/spotify\.com$/.test(h)) return "spotify";
      return h.split(".")[0];
    } catch (e) { return ""; }
  }
  const EMBED_PROVIDERS = /^(youtube|vimeo|tiktok|twitter|instagram|facebook|soundcloud|spotify)$/;
  function isEmbeddable(url) {
    if (!/^https:\/\/\S+$/i.test(url || "")) return false;
    const p = videoProvider(url);
    if (!EMBED_PROVIDERS.test(p)) return false;
    if (p === "twitter") return /\/status(es)?\/\d+/.test(url);
    return true;
  }
  function normalizeEmbedUrl(url) {
    // ووردبريس يعرف twitter.com في التضمين التلقائي؛ x.com نحوّله ليعمل في كل الإصدارات
    return String(url || "").trim().replace(/^https:\/\/(www\.|mobile\.)?x\.com\//i, "https://twitter.com/");
  }
  function youtubeId(url) {
    const m = (url || "").match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
    return m ? m[1] : "";
  }
  function embedBlock(url) {
    url = normalizeEmbedUrl(url);
    const prov = videoProvider(url);
    const type = /^(youtube|vimeo|tiktok)$/.test(prov) ? "video" : "rich";
    const attrs = JSON.stringify({ url, type, providerNameSlug: prov, responsive: true });
    const cls = "wp-block-embed is-type-" + type + " is-provider-" + prov + " wp-block-embed-" + prov;
    return `<!-- wp:embed ${attrs} -->\n<figure class="${cls}"><div class="wp-block-embed__wrapper">\n${url}\n</div></figure>\n<!-- /wp:embed -->`;
  }
  function embedUrlFromIframe(src) {
    const yt = youtubeId(src || "");
    if (yt) return "https://www.youtube.com/watch?v=" + yt;
    const vm = (src || "").match(/player\.vimeo\.com\/video\/(\d+)/);
    if (vm) return "https://vimeo.com/" + vm[1];
    return "";
  }

  // ———————————————————— تنظيف HTML (لصق ومحتوى الموقع) ————————————————————
  const BLOCKISH = new Set(["p", "div", "section", "article", "header", "footer", "main", "aside", "nav", "li", "dd", "dt", "dl", "pre", "address", "center", "body", "html", "details", "summary", "figcaption", "picture"]);
  const DROP = "script,style,meta,link,noscript,template,svg,canvas,object,embed,form,input,button,select,textarea,head,title,video,audio,source,track,map";

  function safeHref(h) {
    h = (h || "").trim();
    if (/^(https?:|mailto:|tel:)/i.test(h)) return h;
    if (/^\/\//.test(h)) return "https:" + h;
    return "";
  }
  function cleanInline(node) {
    const frag = document.createDocumentFragment();
    node.childNodes.forEach((ch) => {
      if (ch.nodeType === 3) { frag.appendChild(document.createTextNode(ch.nodeValue.replace(/[\t\r\n]+/g, " "))); return; }
      if (ch.nodeType !== 1) return;
      const tag = ch.tagName.toLowerCase();
      if (tag === "br") { frag.appendChild(document.createElement("br")); return; }
      if (tag === "img" || tag === "iframe" || ch.matches(DROP)) return;
      let el = null;
      if (tag === "b" || tag === "strong") el = document.createElement("strong");
      else if (tag === "i" || tag === "em") el = document.createElement("em");
      else if (tag === "sub" || tag === "sup") el = document.createElement(tag);
      else if (tag === "a") { const h = safeHref(ch.getAttribute("href")); if (h) { el = document.createElement("a"); el.setAttribute("href", h); } }
      else if (tag === "span" && /font-weight:\s*(bold|[6-9]00)/i.test(ch.getAttribute("style") || "")) el = document.createElement("strong");
      const inner = cleanInline(ch);
      if (el) { el.appendChild(inner); if (el.textContent.trim() || el.querySelector("br")) frag.appendChild(el); }
      else frag.appendChild(inner);
    });
    return frag;
  }
  function inlineHtml(node) {
    const d = document.createElement("div");
    d.appendChild(cleanInline(node));
    // دمج الوسوم المتتالية المتطابقة وإزالة الفراغات الطرفية
    let h = d.innerHTML.replace(/<\/strong><strong>/g, "").replace(/<\/em><em>/g, "");
    h = h.replace(/^(\s|&nbsp;|<br>)+|(\s|&nbsp;|<br>)+$/g, "");
    return h;
  }
  function cleanList(n) {
    const out = document.createElement(n.tagName.toLowerCase() === "ol" ? "ol" : "ul");
    Array.from(n.children).forEach((li) => {
      if (li.tagName.toLowerCase() !== "li") return;
      const item = document.createElement("li");
      const nested = [];
      const tmp = document.createElement("div");
      li.childNodes.forEach((c) => {
        if (c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName)) nested.push(cleanList(c));
        else tmp.appendChild(c.cloneNode(true));
      });
      item.innerHTML = inlineHtml(tmp);
      nested.forEach((x) => item.appendChild(x));
      if (item.textContent.trim()) out.appendChild(item);
    });
    return out;
  }
  function pickSrc(img) {
    let src = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original") || img.getAttribute("src") || "";
    if (!src || /^data:image\/(gif|svg)/i.test(src) || /^blob:/i.test(src)) {
      const ss = img.getAttribute("srcset") || img.getAttribute("data-srcset") || "";
      const first = ss.split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean).pop();
      if (first) src = first;
    }
    if (/^\/\//.test(src)) src = "https:" + src;
    if (!/^(https?:|data:image\/)/i.test(src)) return "";
    return src;
  }
  function wpIdFromClass(el) {
    const m = ((el && el.getAttribute("class")) || "").match(/wp-image-(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  /** يحوّل HTML (ملصوق أو من الموقع) إلى قائمة كتل للمحرر. preserve=true يحفظ الجداول والأكواد كما هي. */
  function htmlToBlocks(html, preserve) {
    const doc = new DOMParser().parseFromString("<body>" + html + "</body>", "text/html");
    if (!preserve) doc.querySelectorAll(DROP).forEach((n) => n.remove());
    else doc.querySelectorAll("style,meta,link,head,title,template").forEach((n) => n.remove());
    const out = [];
    let cur = null;
    const flush = () => {
      if (cur) {
        const p = document.createElement("p");
        p.innerHTML = inlineHtml(cur);
        if (cur.dataset.align) p.dataset.align = cur.dataset.align;
        if (cur.getAttribute("dir") === "ltr") p.setAttribute("dir", "ltr");
        if (p.textContent.trim()) {
          const embedUrl = p.textContent.trim();
          if (!p.querySelector("br") && isEmbeddable(embedUrl) && !/\s/.test(embedUrl)) out.push(makeEmbedBlock(embedUrl));
          else out.push(p);
        }
      }
      cur = null;
    };
    const holder = () => { if (!cur) cur = document.createElement("div"); return cur; };
    const alignOf = (n) => {
      const st = (n.getAttribute && n.getAttribute("style")) || "";
      const m = st.match(/text-align:\s*(center|left|right|justify)/i) || ((n.getAttribute && n.getAttribute("class")) || "").match(/has-text-align-(center|left|right|justify)/);
      return m ? m[1].toLowerCase() : "";
    };

    function visit(n) {
      if (n.nodeType === 3) { if (n.nodeValue.trim() || cur) holder().appendChild(document.createTextNode(n.nodeValue)); return; }
      if (n.nodeType !== 1) return;
      const tag = n.tagName.toLowerCase();
      if (n.hasAttribute("data-embed")) { flush(); const u = n.getAttribute("data-embed"); if (u) out.push(makeEmbedBlock(u)); return; }
      if (n.hasAttribute("data-gallery")) { flush(); out.push(makeGalleryBlock(n.getAttribute("data-gallery").split(",").map((x) => ({ id: parseInt(x, 10) })).filter((x) => x.id), n.getAttribute("data-caption") || "")); return; }
      if (preserve && (tag === "script" || tag === "table" || tag === "iframe" && !embedUrlFromIframe(n.getAttribute("src")) || tag === "video" || tag === "audio" || tag === "object" || tag === "embed" || tag === "form" || tag === "svg")) {
        flush(); out.push(makeRawBlock(n.outerHTML)); return;
      }
      if (tag === "img") {
        const src = pickSrc(n);
        if (src) { flush(); out.push(makeImageBlock({ src, alt: n.getAttribute("alt") || "", id: wpIdFromClass(n), w: parseInt(n.getAttribute("width"), 10) || 0, h: parseInt(n.getAttribute("height"), 10) || 0 })); }
        return;
      }
      if (tag === "iframe") { const u = embedUrlFromIframe(n.getAttribute("src")); if (u) { flush(); out.push(makeEmbedBlock(u)); } return; }
      if (/^h[1-6]$/.test(tag)) {
        flush();
        const lvl = tag === "h1" || tag === "h2" ? "h2" : tag === "h3" ? "h3" : "h4";
        const h = document.createElement(lvl);
        h.innerHTML = inlineHtml(n);
        const al = alignOf(n); if (al) h.dataset.align = al;
        if (h.textContent.trim()) out.push(h);
        n.querySelectorAll("img").forEach(visit);
        return;
      }
      if (tag === "ul" || tag === "ol") { flush(); const l = cleanList(n); if (l.children.length) out.push(l); n.querySelectorAll("img").forEach(visit); return; }
      if (tag === "blockquote") {
        flush();
        const cls = n.getAttribute("class") || "";
        if (/twitter-tweet|instagram-media|tiktok-embed/.test(cls)) {
          const links = Array.from(n.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")).filter((h) => isEmbeddable(h) || /instagram\.com\/(p|reel)\//.test(h));
          const u = links.pop() || n.getAttribute("cite") || "";
          if (u && isEmbeddable(u)) { out.push(makeEmbedBlock(u.split("?")[0])); return; }
        }
        const q = document.createElement("blockquote");
        htmlToBlocks(n.innerHTML, false).forEach((b) => {
          if (b.matches && b.matches("p,h2,h3,h4")) { const p = document.createElement("p"); p.innerHTML = b.innerHTML; q.appendChild(p); }
        });
        if (q.textContent.trim()) out.push(q);
        return;
      }
      if (tag === "figure") {
        flush();
        const img = n.querySelector("img");
        const ifr = n.querySelector("iframe");
        const cap = n.querySelector("figcaption");
        if (/wp-block-embed/.test(n.getAttribute("class") || "")) {
          const u = (n.textContent || "").trim().split(/\s+/)[0];
          if (u && /^https?:/.test(u)) { out.push(makeEmbedBlock(u)); return; }
        }
        if (img && n.querySelectorAll("img").length > 1) {
          const items = Array.from(n.querySelectorAll("img")).map((im) => ({ src: pickSrc(im), alt: im.getAttribute("alt") || "", id: wpIdFromClass(im) || parseInt(im.getAttribute("data-id"), 10) || 0 })).filter((x) => x.src);
          out.push(makeGalleryBlock(items, cap ? inlineHtml(cap) : ""));
          return;
        }
        if (img) {
          const src = pickSrc(img);
          if (src) out.push(makeImageBlock({ src, alt: img.getAttribute("alt") || "", id: wpIdFromClass(img), caption: cap ? inlineHtml(cap) : "", w: parseInt(img.getAttribute("width"), 10) || 0, h: parseInt(img.getAttribute("height"), 10) || 0 }));
          return;
        }
        if (ifr) { visit(ifr); return; }
        Array.from(n.childNodes).forEach(visit); flush();
        return;
      }
      if (tag === "table") {
        flush();
        n.querySelectorAll("tr").forEach((tr) => {
          const t = Array.from(tr.children).map((c) => c.textContent.trim()).filter(Boolean).join(" | ");
          if (t) { const p = document.createElement("p"); p.textContent = t; out.push(p); }
        });
        return;
      }
      if (tag === "br") { if (cur) cur.appendChild(document.createElement("br")); return; }
      if (tag === "hr") { flush(); return; }
      if (BLOCKISH.has(tag)) {
        flush();
        const al = alignOf(n);
        const hasBlocks = n.querySelector("p,div,h1,h2,h3,h4,h5,h6,ul,ol,blockquote,figure,img,iframe,table,section,article,script");
        if (!hasBlocks) {
          if (tag === "pre") { n.textContent.split(/\n/).forEach((line) => { if (line.trim()) { const p = document.createElement("p"); p.textContent = line; out.push(p); } }); return; }
          holder().appendChild(n.cloneNode(true));
          if (al) cur.dataset.align = al;
          if (n.getAttribute("dir") === "ltr") cur.setAttribute("dir", "ltr");
          flush();
          return;
        }
        Array.from(n.childNodes).forEach(visit);
        flush();
        return;
      }
      // عنصر سطري: إن احتوى صوراً أو كتلاً نمرّ على أبنائه، وإلا نضيفه للفقرة الحالية
      if (n.querySelector("img,iframe,p,div,h1,h2,h3,h4,ul,ol,blockquote,figure,table")) { Array.from(n.childNodes).forEach(visit); return; }
      holder().appendChild(n.cloneNode(true));
    }
    Array.from(doc.body.childNodes).forEach(visit);
    flush();
    return out;
  }

  /** تحويل نص ووردبريس الكلاسيكي (فقرات بأسطر فارغة + أكواد قصيرة) إلى HTML */
  function preprocessRaw(raw) {
    let s = raw || "";
    s = s.replace(ANY_EMBED_RE, (m, json) => { let u = ""; try { u = JSON.parse(json).url || ""; } catch (e) { u = ""; } return u ? `\n\n<p data-embed="${escapeHtml(u)}"></p>\n\n` : ""; });
    s = s.replace(/<!--\s*\/?wp:[\s\S]*?-->/g, "");
    s = s.replace(/\[caption([^\]]*)\]([\s\S]*?)\[\/caption\]/g, (m, attrs, inner) => {
      const im = inner.match(/<img[^>]*>/i);
      if (!im) return inner;
      const capText = inner.replace(/<a[^>]*>\s*<img[^>]*>\s*<\/a>|<img[^>]*>/i, "").trim();
      return `\n\n<figure>${im[0]}<figcaption>${capText}</figcaption></figure>\n\n`;
    });
    s = s.replace(/(<p[^>]*>\s*)?\[gallery([^\]]*)\](\s*<\/p>)?(\s*<p class="ahwal-gallery-caption">([\s\S]*?)<\/p>)?/g, (m, a, attrs, b, c, cap) => {
      const ids = (attrs.match(/ids=["']?([\d,\s]+)/) || [])[1];
      if (!ids) return m;
      return `\n\n<p data-gallery="${ids.replace(/\s+/g, "")}" data-caption="${escapeHtml(cap || "")}"></p>\n\n`;
    });
    // فقرات تلقائية مثل wpautop (مبسطة)
    if (/\n\s*\n/.test(s) || !/<(p|h[1-6]|ul|ol|blockquote|figure|div|table)[\s>]/i.test(s)) {
      s = s.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean).map((b) =>
        /^<(p|h[1-6]|ul|ol|blockquote|figure|div|table|script|iframe|hr|pre|section)[\s>]/i.test(b) ? b : "<p>" + b.replace(/\n/g, "<br>") + "</p>"
      ).join("\n");
    }
    return s;
  }

  // ———————————————————— كتل المحرر (صورة / معرض / تضمين / HTML) ————————————————————
  const rawStore = new Map();
  let rawSeq = 0;
  const TOOLS = (extra) => `<div class="blk-tools" contenteditable="false">${extra || ""}<button type="button" data-act="up" title="أعلى">↑</button><button type="button" data-act="down" title="أسفل">↓</button><button type="button" data-act="del" title="حذف">✕</button></div>`;

  function makeImageBlock(o) {
    const f = document.createElement("figure");
    f.className = "ed-blk ed-img";
    f.contentEditable = "false";
    f.dataset.type = "image";
    if (o.id) f.dataset.id = String(o.id);
    if (o.w) f.dataset.w = String(o.w);
    if (o.h) f.dataset.h = String(o.h);
    f.dataset.size = o.size || "large";
    f.innerHTML = TOOLS('<button type="button" data-act="featured" title="اجعلها الصورة البارزة">★ بارزة</button>') +
      `<div class="blk-media"><img alt="" referrerpolicy="no-referrer"><div class="blk-progress"><div></div></div><span class="blk-badge"></span></div>` +
      `<input class="blk-alt" type="text" placeholder="النص البديل: صف الصورة لمحركات البحث" maxlength="200">` +
      `<figcaption contenteditable="true" data-ph="اكتب تعليقاً على الصورة (اختياري)"></figcaption>`;
    const img = f.querySelector("img");
    img.src = o.src || "";
    img.alt = o.alt || "";
    f.querySelector(".blk-alt").value = o.alt || "";
    f.querySelector("figcaption").innerHTML = o.caption || "";
    img.addEventListener("load", () => { if (!f.dataset.w && img.naturalWidth) { f.dataset.w = String(img.naturalWidth); f.dataset.h = String(img.naturalHeight); } });
    markRemote(f, o.src, o.id);
    return f;
  }
  function markRemote(el, src, id) {
    const remote = !id && /^https?:/.test(src || "") && !/^https:\/\/(www\.)?ahwal\.sa\//.test(src);
    el.classList.toggle("is-remote", remote);
    const b = el.querySelector(":scope > .blk-media .blk-badge, :scope > .blk-badge");
    if (b) b.textContent = remote ? "صورة خارجية" : "";
  }
  function galItem(o) {
    const d = document.createElement("div");
    d.className = "gal-item";
    if (o.id) d.dataset.id = String(o.id);
    d.innerHTML = `<img alt="" referrerpolicy="no-referrer"><button type="button" class="gal-x" data-act="gal-del" title="إزالة">✕</button><div class="blk-progress"><div></div></div><span class="blk-badge"></span><input class="blk-alt" type="text" placeholder="نص بديل" maxlength="200">`;
    d.querySelector("img").src = o.src || "";
    d.querySelector(".blk-alt").value = o.alt || "";
    d.dataset.altOrig = o.alt || "";
    const remote = !o.id && /^https?:/.test(o.src || "");
    d.classList.toggle("is-remote", remote);
    d.querySelector(".blk-badge").textContent = remote ? "خارجية" : "";
    return d;
  }
  function makeGalleryBlock(items, caption) {
    const f = document.createElement("figure");
    f.className = "ed-blk ed-gal";
    f.contentEditable = "false";
    f.dataset.type = "gallery";
    f.innerHTML = TOOLS('<button type="button" data-act="gal-add" title="إضافة صور للمعرض">＋ صور</button>') +
      `<div class="gal-head">🗂️ معرض صور <small>اسحب الصور أو الصقها هنا لإضافتها</small></div><div class="gal-grid"></div>` +
      `<figcaption contenteditable="true" data-ph="تعليق على المعرض (اختياري)"></figcaption>`;
    const grid = f.querySelector(".gal-grid");
    (items || []).forEach((o) => grid.appendChild(galItem(o)));
    f.querySelector("figcaption").innerHTML = caption || "";
    const missing = (items || []).filter((o) => o.id && !o.src).map((o) => o.id);
    if (missing.length) fillGalleryMedia(f, missing);
    return f;
  }
  async function fillGalleryMedia(f, ids) {
    try {
      const { data } = await api("/media?per_page=100&include=" + ids.join(",") + "&_fields=id,source_url,alt_text,media_details");
      (data || []).forEach((m) => {
        const it = f.querySelector(`.gal-item[data-id="${m.id}"]`);
        if (!it) return;
        it.querySelector("img").src = bigImageOf(m);
        const alt = m.alt_text || "";
        it.querySelector(".blk-alt").value = alt;
        it.dataset.altOrig = alt;
      });
      scheduleAnalysis();
    } catch (e) { /* تبقى المعاينة فارغة لكن المعرّفات محفوظة */ }
  }
  function makeEmbedBlock(url) {
    url = normalizeEmbedUrl(url);
    const f = document.createElement("figure");
    f.className = "ed-blk ed-embed";
    f.contentEditable = "false";
    f.dataset.type = "embed";
    f.dataset.url = url;
    const prov = videoProvider(url);
    const yt = youtubeId(url);
    const label = { youtube: "يوتيوب", twitter: "إكس (تويتر)", vimeo: "فيميو", tiktok: "تيك توك", instagram: "إنستقرام", facebook: "فيسبوك" }[prov] || prov;
    f.innerHTML = TOOLS() + `<div class="emb-card">${yt ? `<img src="https://i.ytimg.com/vi/${escapeHtml(yt)}/hqdefault.jpg" alt="" referrerpolicy="no-referrer">` : `<span class="emb-ico">${prov === "twitter" ? "𝕏" : "▶"}</span>`}<div><b>تضمين ${escapeHtml(label)}</b><span dir="ltr">${escapeHtml(url)}</span></div></div>`;
    return f;
  }
  function makeRawBlock(html) {
    const id = "raw" + (++rawSeq);
    rawStore.set(id, html);
    const f = document.createElement("figure");
    f.className = "ed-blk ed-raw";
    f.contentEditable = "false";
    f.dataset.type = "raw";
    f.dataset.raw = id;
    const tag = ((html.match(/^<\s*([a-z0-9]+)/i) || [])[1] || "html").toLowerCase();
    const name = { table: "جدول", script: "كود تضمين", iframe: "إطار مضمّن", video: "فيديو", audio: "صوت" }[tag] || "محتوى HTML";
    f.innerHTML = TOOLS() + `<div class="raw-card"><b>${escapeHtml(name)}</b> — يبقى كما هو في الموقع (يُعدَّل من لوحة ووردبريس).<code dir="ltr"></code></div>`;
    f.querySelector("code").textContent = html.replace(/\s+/g, " ").slice(0, 140) + (html.length > 140 ? "…" : "");
    return f;
  }

  // ———————————————————— المحرر: تحميل وحفظ ————————————————————
  const ed = () => $("f-body");
  function topBlockOf(node) {
    const root = ed();
    while (node && node.parentNode !== root) { if (node === root || !node.parentNode) return null; node = node.parentNode; }
    return node && node.parentNode === root ? node : null;
  }
  function emptyP() { const p = document.createElement("p"); p.appendChild(document.createElement("br")); return p; }
  function ensureTail() {
    const root = ed();
    const last = root.lastElementChild;
    if (!last || last.classList.contains("ed-blk")) root.appendChild(emptyP());
    // كتلتان متتاليتان بلا فقرة بينهما يصعب الكتابة بينهما؛ لا نضيف تلقائياً لتجنب الفراغات
    root.classList.toggle("is-empty", !root.textContent.trim() && !root.querySelector(".ed-blk"));
  }
  function loadBody(rawHtml) {
    const root = ed();
    root.innerHTML = "";
    rawStore.clear();
    htmlToBlocks(preprocessRaw(rawHtml), true).forEach((b) => root.appendChild(b));
    ensureTail();
  }

  function figCaptionHtml(fc) { return fc ? inlineHtml(fc).replace(/[\[\]]/g, "") : ""; }
  function imgTag(src, alt, id, size, w, h) {
    const cls = "aligncenter size-" + (size || "large") + (id ? " wp-image-" + id : "");
    return `<img class="${cls}" src="${escapeHtml(src)}" alt="${escapeHtml(alt || "")}"${w ? ` width="${w}"` : ""}${h ? ` height="${h}"` : ""} />`;
  }
  function blockAttrs(el) {
    const al = el.dataset.align;
    let a = "";
    if (al && al !== "right") a += ` style="text-align: ${al};"`;
    if (el.getAttribute("dir") === "ltr") a += ' dir="ltr"';
    return a;
  }
  /** يُخرج HTML كلاسيكي متوافق مع محرر ووردبريس الكلاسيكي وقالب الموقع */
  function serializeBlock(el, out, opts) {
    opts = opts || {};
    if (el.nodeType === 3) { if (el.nodeValue.trim()) out.push("<p>" + escapeHtml(el.nodeValue.trim()) + "</p>"); return; }
    if (el.nodeType !== 1) return;
    const tag = el.tagName.toLowerCase();
    if (el.classList.contains("ed-blk")) {
      const t = el.dataset.type;
      if (t === "image") {
        if (el.classList.contains("is-uploading") || el.classList.contains("is-error")) return;
        const img = el.querySelector("img");
        const src = img && img.getAttribute("src");
        if (!src || /^(blob|data):/.test(src)) return;
        const alt = el.querySelector(".blk-alt").value.trim();
        const id = parseInt(el.dataset.id, 10) || 0;
        const w = parseInt(el.dataset.w, 10) || 0, h = parseInt(el.dataset.h, 10) || 0;
        const cap = figCaptionHtml(el.querySelector("figcaption"));
        const tagHtml = imgTag(src, alt, id, el.dataset.size, w, h);
        if (opts.preview) { out.push(`<figure class="pv-fig"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" referrerpolicy="no-referrer">${cap ? `<figcaption>${cap}</figcaption>` : ""}</figure>`); return; }
        if (cap) out.push(`[caption${id ? ` id="attachment_${id}"` : ""} align="aligncenter" width="${w || 1024}"]${tagHtml} ${cap}[/caption]`);
        else out.push(`<p>${tagHtml}</p>`);
        return;
      }
      if (t === "gallery") {
        const items = Array.from(el.querySelectorAll(".gal-item")).filter((it) => !it.classList.contains("is-uploading") && !it.classList.contains("is-error"));
        const cap = figCaptionHtml(el.querySelector("figcaption"));
        if (opts.preview) {
          out.push(`<figure class="pv-gal pv-gal-${Math.min(items.length, 3)}">${items.map((it) => `<img src="${escapeHtml(it.querySelector("img").getAttribute("src") || "")}" alt="" referrerpolicy="no-referrer">`).join("")}${cap ? `<figcaption>${cap}</figcaption>` : ""}</figure>`);
          return;
        }
        const withId = items.filter((it) => parseInt(it.dataset.id, 10));
        const remote = items.filter((it) => !parseInt(it.dataset.id, 10));
        if (withId.length) {
          const n = withId.length;
          const cols = n === 1 ? 1 : n === 2 ? 2 : n === 4 ? 2 : 3;
          out.push(`[gallery ids="${withId.map((it) => it.dataset.id).join(",")}" size="large" link="file" columns="${cols}"]`);
        }
        remote.forEach((it) => {
          const src = it.querySelector("img").getAttribute("src") || "";
          if (src && !/^(blob|data):/.test(src)) out.push(`<p>${imgTag(src, it.querySelector(".blk-alt").value.trim(), 0, "large")}</p>`);
        });
        if (cap && items.length) out.push(`<p class="ahwal-gallery-caption">${cap}</p>`);
        return;
      }
      if (t === "embed") {
        const u = el.dataset.url;
        if (!u) return;
        if (opts.preview) {
          const yt = youtubeId(u);
          out.push(yt ? `<div class="pv-embed"><iframe src="https://www.youtube-nocookie.com/embed/${escapeHtml(yt)}" title="فيديو" allowfullscreen loading="lazy"></iframe></div>` : `<p class="pv-embed-link">📎 <a href="${escapeHtml(u)}" target="_blank" rel="noopener">${escapeHtml(u)}</a></p>`);
          return;
        }
        out.push(embedBlock(u));
        return;
      }
      if (t === "raw") {
        const html = rawStore.get(el.dataset.raw) || "";
        out.push(opts.preview ? `<p class="pv-raw">[محتوى HTML يظهر في الموقع]</p>` : html);
        return;
      }
      return;
    }
    if (tag === "p" || tag === "div") {
      if (el.querySelector("img,iframe,ul,ol,h1,h2,h3,h4,blockquote,table,figure")) { htmlToBlocks(el.outerHTML, false).forEach((b) => serializeBlock(b, out, opts)); return; }
      const inner = inlineHtml(el);
      if (inner && el.textContent.trim()) out.push(`<p${blockAttrs(el)}>${inner}</p>`);
      return;
    }
    if (/^h[2-4]$/.test(tag)) { const inner = inlineHtml(el); if (el.textContent.trim()) out.push(`<${tag}${blockAttrs(el)}>${inner}</${tag}>`); return; }
    if (tag === "ul" || tag === "ol") { const l = cleanList(el); if (l.children.length) out.push(l.outerHTML); return; }
    if (tag === "blockquote") {
      const ps = Array.from(el.querySelectorAll("p")).map((p) => inlineHtml(p)).filter(Boolean);
      const parts = ps.length ? ps : [inlineHtml(el)].filter(Boolean);
      if (parts.length) out.push("<blockquote>" + parts.map((x) => "<p>" + x + "</p>").join("") + "</blockquote>");
      return;
    }
    if (tag === "br") return;
    htmlToBlocks(el.outerHTML, false).forEach((b) => serializeBlock(b, out, opts));
  }
  function serializeBody(opts) {
    const out = [];
    ed().childNodes.forEach((n) => serializeBlock(n, out, opts));
    return out.join("\n\n");
  }
  function buildContent() {
    const parts = [];
    const dl = $("f-dateline").value.trim();
    if (dl) parts.push(`<p class="ahwal-dateline">${escapeHtml(dl)}</p>`);
    const body = serializeBody();
    if (body) parts.push(body);
    const video = $("f-video").value.trim();
    if (video) parts.push(embedBlock(video));
    return parts.join("\n\n");
  }

  // ———————————————————— المحرر: الإدراج والتحديد ————————————————————
  let savedRange = null;
  function keepSelection() {
    const s = window.getSelection();
    if (s.rangeCount && ed().contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
  }
  function restoreSelection() {
    ed().focus();
    if (savedRange && ed().contains(savedRange.startContainer)) { const s = window.getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
  }
  function caretInto(el) {
    const r = document.createRange();
    r.selectNodeContents(el); r.collapse(true);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    savedRange = r.cloneRange();
  }
  function caretAtEnd(el) {
    const r = document.createRange();
    r.selectNodeContents(el); r.collapse(false);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
    savedRange = r.cloneRange();
  }
  function currentTop() {
    const r = savedRange;
    if (!r) return null;
    const n = r.startContainer;
    if (!ed().contains(n)) return null;
    if (n === ed()) return ed().childNodes[Math.max(0, r.startOffset - 1)] || null;
    return topBlockOf(n);
  }
  /** يدرج كتلاً بعد الفقرة الحالية (أو مكانها إن كانت فارغة) ثم يضع المؤشر بعدها */
  function insertBlocks(nodes, at) {
    const root = ed();
    let ref = at !== undefined ? at : currentTop();
    if (ref && ref.parentNode !== root) ref = topBlockOf(ref);
    let anchor;
    if (ref && !ref.classList.contains("ed-blk") && !ref.textContent.trim() && !ref.querySelector("img")) { anchor = ref.previousSibling; ref.remove(); ref = anchor; }
    let after = ref ? ref.nextSibling : null;
    if (!ref) after = null;
    nodes.forEach((n) => root.insertBefore(n, after));
    const last = nodes[nodes.length - 1];
    let next = last && last.nextElementSibling;
    if (last && last.classList && last.classList.contains("ed-blk") && (!next || next.classList.contains("ed-blk"))) { next = emptyP(); root.insertBefore(next, last.nextSibling); }
    ensureTail();
    if (last && !last.classList.contains("ed-blk")) { ed().focus(); caretAtEnd(last); }
    else if (next && !next.classList.contains("ed-blk")) { ed().focus(); caretInto(next); }
    changed();
  }

  // ———————————————————— رفع الصور في الخلفية ————————————————————
  const upQueue = [];
  let upActive = 0;
  state.pendingUploads = 0;
  function enqueueUpload(job) { state.pendingUploads++; updatePending(); upQueue.push(job); pumpUploads(); }
  function pumpUploads() {
    while (upActive < 2 && upQueue.length) {
      const job = upQueue.shift();
      upActive++;
      job().finally(() => { upActive--; state.pendingUploads--; updatePending(); pumpUploads(); });
    }
  }
  function updatePending() {
    const n = state.pendingUploads;
    const note = $("autosave-note");
    if (n > 0) { note.textContent = "جاري رفع " + n + " صورة…"; note.classList.add("is-busy"); }
    else { note.classList.remove("is-busy"); if (/جاري رفع/.test(note.textContent)) note.textContent = ""; }
  }
  function canUpload() { return !!state.caps.upload_files; }
  function imageFiles(list) { return Array.from(list || []).filter((f) => f && /^image\//.test(f.type || "")); }

  /** يرفع ملفاً ويضعه في عنصر (صورة مفردة أو عنصر معرض) مع شريط تقدّم */
  function uploadInto(el, file, isGal) {
    const img = el.querySelector("img");
    const local = URL.createObjectURL(file);
    img.src = local;
    el.classList.add("is-uploading");
    el.classList.remove("is-error", "is-remote");
    const badge = el.querySelector(".blk-badge"); if (badge) badge.textContent = "";
    const bar = el.querySelector(".blk-progress > div");
    bar.style.width = "4%";
    enqueueUpload(async () => {
      try {
        const blob = await shrinkImage(file);
        const ext = blob.type === "image/png" ? "png" : blob.type === "image/webp" ? "webp" : blob.type === "image/gif" ? "gif" : "jpg";
        const media = await uploadMedia(blob, "ahwal-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6) + "." + ext, (f) => { bar.style.width = Math.max(4, Math.round(f * 100)) + "%"; });
        const s = (media.media_details && media.media_details.sizes) || {};
        const big = s.large || s.full || null;
        img.src = (big && big.source_url) || media.source_url;
        el.dataset.id = String(media.id);
        if (!isGal) {
          el.dataset.size = s.large ? "large" : "full";
          const mw = big ? big.width : media.media_details && media.media_details.width;
          const mh = big ? big.height : media.media_details && media.media_details.height;
          if (mw) { el.dataset.w = String(mw); el.dataset.h = String(mh || ""); }
        }
        el.classList.remove("is-uploading");
        URL.revokeObjectURL(local);
        const alt = el.querySelector(".blk-alt");
        if (alt && !alt.value.trim() && $("f-title").value.trim() && isGal) { /* نص بديل المعرض يُحفظ في المكتبة عند الحفظ */ }
        changed();
      } catch (err) {
        el.classList.remove("is-uploading");
        el.classList.add("is-error");
        if (badge) badge.textContent = "تعذّر الرفع";
        toast(errMsg(err));
      }
    });
  }
  function insertImageFiles(files, at) {
    files = imageFiles(files);
    if (!files.length) return;
    if (!canUpload()) { toast("صلاحيتك لا تسمح برفع الصور. يمكنك لصق صور من مواقع أخرى."); return; }
    if (files.length === 1) {
      const f = makeImageBlock({ src: "" });
      insertBlocks([f], at);
      uploadInto(f, files[0], false);
    } else {
      const g = makeGalleryBlock([], "");
      insertBlocks([g], at);
      addToGallery(g, files);
    }
  }
  function addToGallery(g, files) {
    files = imageFiles(files);
    if (!files.length) return;
    if (!canUpload()) { toast("صلاحيتك لا تسمح برفع الصور."); return; }
    const grid = g.querySelector(".gal-grid");
    files.forEach((file) => { const it = galItem({ src: "" }); grid.appendChild(it); uploadInto(it, file, true); });
    changed();
  }
  /** صور ملصوقة من مواقع أخرى: نعيد رفعها لمكتبة الموقع إن سمح الموقع المصدر (CORS)، وإلا نبقي الرابط */
  async function adoptRemote(el, isGal) {
    const img = el.querySelector("img");
    const src = img && img.getAttribute("src");
    if (!src || el.dataset.id) return;
    if (/^https:\/\/(www\.)?ahwal\.sa\//.test(src)) return;
    if (!canUpload()) return;
    let blob = null;
    try {
      if (/^data:image\//.test(src)) blob = await (await fetch(src)).blob();
      else {
        const res = await fetch(src, { mode: "cors", credentials: "omit", referrerPolicy: "no-referrer" });
        if (res.ok) blob = await res.blob();
      }
    } catch (e) { blob = null; }
    if (blob && /^image\//.test(blob.type) && blob.size > 0) {
      const file = new File([blob], "pasted." + (blob.type.split("/")[1] || "jpg"), { type: blob.type });
      uploadInto(el, file, isGal);
    } else if (/^data:/.test(src)) {
      el.remove(); changed();
    } else {
      markRemote(el, src, 0);
    }
  }
  function adoptAllRemote(nodes) {
    nodes.forEach((n) => {
      if (!n.classList || !n.classList.contains("ed-blk")) return;
      if (n.dataset.type === "image") adoptRemote(n, false);
      if (n.dataset.type === "gallery") n.querySelectorAll(".gal-item").forEach((it) => adoptRemote(it, true));
    });
  }

  // ———————————————————— اللصق والسحب ————————————————————
  function inCaption(node) { const e = node && (node.nodeType === 1 ? node : node.parentElement); return !!(e && e.closest("figcaption")); }
  function textToBlocks(text) {
    return text.replace(/\r/g, "").split(/\n\s*\n|\n(?=\s*https?:\/\/\S+\s*(\n|$))/).map((b) => (b || "").trim()).filter(Boolean).map((b) => {
      if (!/\s/.test(b) && isEmbeddable(b)) return makeEmbedBlock(b);
      const p = document.createElement("p");
      p.innerHTML = escapeHtml(b).replace(/\n/g, "<br>");
      return p;
    });
  }
  function onPaste(e) {
    const cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    const tgt = e.target;
    if (tgt.closest && tgt.closest(".blk-alt")) return; // حقل النص البديل يلصق نصاً عادياً
    e.preventDefault();
    const sel = window.getSelection();
    if (inCaption(sel.anchorNode)) { document.execCommand("insertText", false, (cd.getData("text/plain") || "").replace(/\s+/g, " ")); return; }
    keepSelection();
    const files = imageFiles(Array.from(cd.items || []).filter((i) => i.kind === "file").map((i) => i.getAsFile()));
    const html = cd.getData("text/html");
    const text = cd.getData("text/plain");
    const htmlHasText = html && stripHtml(html).length > 0;
    const gal = sel.anchorNode && (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
    if (files.length && !htmlHasText) {
      const g = gal && gal.closest && gal.closest(".ed-gal");
      if (g) addToGallery(g, files); else insertImageFiles(files);
      return;
    }
    let blocks;
    if (html) blocks = htmlToBlocks(html, false);
    else blocks = textToBlocks(text || "");
    if (!blocks.length) return;
    // فقرة واحدة بلا كتل: تُدمج في مكان المؤشر للحفاظ على السطر
    if (blocks.length === 1 && blocks[0].tagName === "P" && !blocks[0].dataset.align) {
      document.execCommand("insertHTML", false, blocks[0].innerHTML);
      changed();
      return;
    }
    if (!sel.isCollapsed) document.execCommand("delete");
    keepSelection();
    insertBlocks(blocks);
    adoptAllRemote(blocks);
  }
  function rangeFromPoint(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); if (!p) return null; const r = document.createRange(); r.setStart(p.offsetNode, p.offset); return r; }
    return null;
  }
  function onDrop(e) {
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = imageFiles(dt.files);
    const html = dt.getData("text/html");
    const g = e.target.closest && e.target.closest(".ed-gal");
    if (!files.length && !(html && /<img/i.test(html) && !ed().contains(dragSrc))) return; // سحب نص داخل المحرر: السلوك الافتراضي
    e.preventDefault();
    ed().classList.remove("is-drag");
    if (g) { if (files.length) addToGallery(g, files); return; }
    const r = rangeFromPoint(e.clientX, e.clientY);
    if (r && ed().contains(r.startContainer)) savedRange = r;
    if (files.length) { insertImageFiles(files); return; }
    const blocks = htmlToBlocks(html, false);
    if (blocks.length) { insertBlocks(blocks); adoptAllRemote(blocks); }
  }
  let dragSrc = null;

  // ———————————————————— أوامر شريط الأدوات ————————————————————
  function selectedTops() {
    keepSelection();
    const r = savedRange;
    if (!r) return [];
    const a = topBlockOf(r.startContainer) || currentTop();
    const b = topBlockOf(r.endContainer) || a;
    if (!a) return [];
    const out = [];
    for (let n = a; n; n = n.nextElementSibling) { if (!n.classList.contains("ed-blk")) out.push(n); if (n === b) break; }
    return out;
  }
  function prompt2(title, label, value, okLabel, type) {
    return new Promise((resolve) => {
      $("prompt-title").textContent = title;
      $("prompt-label").textContent = label;
      $("prompt-ok").textContent = okLabel || "إضافة";
      const inp = $("prompt-input");
      inp.type = type || "url";
      inp.value = value || "";
      $("prompt-modal").classList.remove("hidden");
      setTimeout(() => inp.focus(), 30);
      const done = (v) => { $("prompt-modal").classList.add("hidden"); $("prompt-form").onsubmit = null; $("prompt-cancel").onclick = null; resolve(v); };
      $("prompt-form").onsubmit = (e) => { e.preventDefault(); done(inp.value.trim()); };
      $("prompt-cancel").onclick = () => done(null);
    });
  }
  async function runCmd(cmd) {
    if (ed().contentEditable !== "true") return;
    restoreSelection();
    const block = (tag) => {
      const cur = (document.queryCommandValue("formatBlock") || "").toLowerCase();
      document.execCommand("formatBlock", false, cur === tag ? "p" : tag);
    };
    switch (cmd) {
      case "undo": document.execCommand("undo"); break;
      case "redo": document.execCommand("redo"); break;
      case "bold": document.execCommand("bold"); break;
      case "italic": document.execCommand("italic"); break;
      case "h2": block("h2"); break;
      case "h3": block("h3"); break;
      case "quote": block("blockquote"); break;
      case "ul": document.execCommand("insertUnorderedList"); break;
      case "ol": document.execCommand("insertOrderedList"); break;
      case "unlink": document.execCommand("unlink"); break;
      case "clear": document.execCommand("removeFormat"); document.execCommand("formatBlock", false, "p"); document.execCommand("unlink"); selectedTops().forEach((b) => { delete b.dataset.align; b.removeAttribute("dir"); }); break;
      case "align-right": case "align-center": case "align-left": case "align-justify": {
        const al = cmd.slice(6);
        const tops = selectedTops();
        const allSame = tops.length && tops.every((b) => (b.dataset.align || "right") === al);
        tops.forEach((b) => { if (al === "right" || allSame) delete b.dataset.align; else b.dataset.align = al; });
        break;
      }
      case "ltr": {
        const tops = selectedTops();
        const on = tops.length && tops.every((b) => b.getAttribute("dir") === "ltr");
        tops.forEach((b) => { if (on) b.removeAttribute("dir"); else b.setAttribute("dir", "ltr"); });
        break;
      }
      case "link": {
        keepSelection();
        const r = savedRange && savedRange.cloneRange();
        const url = await prompt2("إضافة رابط", "الرابط", "https://", "إضافة", "url");
        if (url === null) return;
        if (!/^https?:\/\/\S+$/i.test(url)) { toast("الرابط غير صحيح"); return; }
        savedRange = r; restoreSelection();
        const sel = window.getSelection();
        if (sel.isCollapsed) document.execCommand("insertHTML", false, `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`);
        else document.execCommand("createLink", false, url);
        break;
      }
      case "image": keepSelection(); $("f-body-img").click(); return;
      case "gallery": keepSelection(); $("f-gal-img").click(); return;
      case "embed": {
        keepSelection();
        const r = savedRange && savedRange.cloneRange();
        const url = await prompt2("تضمين فيديو أو تغريدة", "رابط يوتيوب أو إكس أو فيميو أو تيك توك أو إنستقرام", "", "تضمين", "url");
        if (url === null) return;
        if (!isEmbeddable(url)) { toast("هذا الرابط غير مدعوم للتضمين. الصقه كرابط عادي."); return; }
        savedRange = r;
        insertBlocks([makeEmbedBlock(url)]);
        return;
      }
    }
    keepSelection();
    changed();
  }

  function onBlockAction(e) {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    e.preventDefault();
    const blk = b.closest(".ed-blk");
    const act = b.dataset.act;
    if (!blk) return;
    if (act === "up" && blk.previousElementSibling) blk.parentNode.insertBefore(blk, blk.previousElementSibling);
    else if (act === "down" && blk.nextElementSibling) blk.parentNode.insertBefore(blk.nextElementSibling, blk);
    else if (act === "del") { blk.remove(); ensureTail(); }
    else if (act === "featured") {
      const id = parseInt(blk.dataset.id, 10);
      if (!id) { toast("انتظر حتى تُرفع الصورة إلى الموقع أولاً."); return; }
      state.featured = { id, url: blk.querySelector("img").src };
      state.localImage = null;
      setMediaPreview(state.featured.url);
      toast("تم تعيينها صورة بارزة ✓");
    } else if (act === "gal-add") { galTarget = blk; $("f-gal-img").click(); return; }
    else if (act === "gal-del") { const it = b.closest(".gal-item"); if (it) it.remove(); if (!blk.querySelector(".gal-item")) { blk.remove(); ensureTail(); } }
    changed();
  }
  let galTarget = null;

  // ———————————————————— سطر الترويسة ————————————————————
  function autoDateline() {
    const city = $("f-city").value.trim();
    const name = (state.me && state.me.name) || "";
    return ["أحوال", city, name].filter(Boolean).join(" - ");
  }
  function refreshDateline() {
    if (!state.datelineTouched) $("f-dateline").value = autoDateline();
    const v = $("f-dateline").value.trim();
    $("dateline-pv").textContent = v;
    $("dateline-pv").classList.toggle("hidden", !v);
  }

  // ———————————————————— Yoast: الحقول ————————————————————
  function normAr(s) {
    return String(s || "").toLowerCase()
      .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
      .replace(/[أإآٱ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
      .replace(/[«»"'“”‘’()\[\]{}.,،؛;:!؟?\-–—_/|]+/g, " ").replace(/\s+/g, " ").trim();
  }
  /** كل كلمات العبارة موجودة (بأي ترتيب، وتقبل السوابق مثل «ال» و«و») — تقريب لمطابقة Yoast */
  function hasKey(text, key) {
    const k = normAr(key);
    if (!k) return false;
    const hay = " " + normAr(text) + " ";
    return k.split(" ").every((w) => hay.includes(w.replace(/^ال(?=..)/, "")));
  }
  function primaryCatId() {
    const v = parseInt($("f-primary-cat").value, 10);
    if (v && state.selectedCats.has(v)) return v;
    return Array.from(state.selectedCats)[0] || 0;
  }
  function resolveVars(tpl) {
    const title = $("f-title").value.trim();
    const pc = catName(primaryCatId());
    return String(tpl || "")
      .replace(/%%title%%/g, title).replace(/%%sitename%%/g, SITE_NAME).replace(/%%sep%%/g, SEP)
      .replace(/%%(primary_category|category)%%/g, pc).replace(/%%page%%/g, "").replace(/%%currentyear%%/g, String(new Date().getFullYear()))
      .replace(/%%excerpt%%/g, $("f-excerpt").value.trim()).replace(/%%[a-z_]+%%/g, "").replace(/\s+/g, " ").trim();
  }
  function seoTitleResolved() {
    const t = $("f-seo-title").value.trim();
    return resolveVars(t || "%%title%% %%page%% %%sep%% %%sitename%%");
  }
  function bodyText() {
    return Array.from(ed().children).filter((n) => !n.classList.contains("ed-blk")).map((n) => n.textContent).join(" ").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }
  function seoDescEffective() { return $("f-seo-desc").value.trim(); }

  function yoastMetaFromForm() {
    const v = (id) => $(id).value.trim();
    return {
      _yoast_wpseo_title: v("f-seo-title"),
      _yoast_wpseo_metadesc: v("f-seo-desc"),
      _yoast_wpseo_focuskw: v("f-seo-focus"),
      _yoast_wpseo_canonical: v("f-canonical"),
      "_yoast_wpseo_meta-robots-noindex": $("f-noindex").value,
      "_yoast_wpseo_meta-robots-nofollow": $("f-nofollow").checked ? "1" : "",
      _yoast_wpseo_is_cornerstone: $("f-cornerstone").checked ? "1" : "",
      "_yoast_wpseo_opengraph-title": v("f-og-title"),
      "_yoast_wpseo_opengraph-description": v("f-og-desc"),
      "_yoast_wpseo_opengraph-image": state.social.og ? state.social.og.url : "",
      "_yoast_wpseo_opengraph-image-id": state.social.og && state.social.og.id ? String(state.social.og.id) : "",
      "_yoast_wpseo_twitter-title": v("f-tw-title"),
      "_yoast_wpseo_twitter-description": v("f-tw-desc"),
      "_yoast_wpseo_twitter-image": state.social.tw ? state.social.tw.url : "",
      "_yoast_wpseo_twitter-image-id": state.social.tw && state.social.tw.id ? String(state.social.tw.id) : "",
      _yoast_wpseo_primary_category: state.selectedCats.size > 1 && primaryCatId() ? String(primaryCatId()) : "",
    };
  }
  function fillYoast(p) {
    const meta = (p && p.meta && typeof p.meta === "object" && !Array.isArray(p.meta)) ? p.meta : {};
    const g = (k) => (meta[k] == null ? "" : String(meta[k]));
    $("f-seo-title").value = g("_yoast_wpseo_title");
    $("f-seo-desc").value = g("_yoast_wpseo_metadesc");
    $("f-seo-focus").value = g("_yoast_wpseo_focuskw");
    $("f-canonical").value = g("_yoast_wpseo_canonical");
    const ni = g("_yoast_wpseo_meta-robots-noindex");
    $("f-noindex").value = ni === "1" || ni === "2" ? ni : "";
    $("f-nofollow").checked = g("_yoast_wpseo_meta-robots-nofollow") === "1";
    $("f-cornerstone").checked = g("_yoast_wpseo_is_cornerstone") === "1";
    $("f-og-title").value = g("_yoast_wpseo_opengraph-title");
    $("f-og-desc").value = g("_yoast_wpseo_opengraph-description");
    $("f-tw-title").value = g("_yoast_wpseo_twitter-title");
    $("f-tw-desc").value = g("_yoast_wpseo_twitter-description");
    state.social.og = g("_yoast_wpseo_opengraph-image") ? { url: g("_yoast_wpseo_opengraph-image"), id: parseInt(g("_yoast_wpseo_opengraph-image-id"), 10) || 0 } : null;
    state.social.tw = g("_yoast_wpseo_twitter-image") ? { url: g("_yoast_wpseo_twitter-image"), id: parseInt(g("_yoast_wpseo_twitter-image-id"), 10) || 0 } : null;
    state.primaryFromMeta = parseInt(g("_yoast_wpseo_primary_category"), 10) || 0;
    state.yoastAdvanced = !p || Object.prototype.hasOwnProperty.call(meta, "_yoast_wpseo_canonical");
    renderSocial();
    $("yoast-warn").classList.add("hidden");
  }
  function isMetaRejected(err) {
    if (!(err instanceof ApiError)) return false;
    if (err.code === "rest_invalid_param") return true;
    const msg = (err.message || "").toLowerCase();
    return err.status === 400 && /\bmeta\b/.test(msg);
  }
  function renderPrimary() {
    const sel = $("f-primary-cat");
    const ids = Array.from(state.selectedCats);
    $("primary-wrap").classList.toggle("hidden", ids.length < 2);
    const want = parseInt(sel.value, 10) || state.primaryFromMeta;
    sel.innerHTML = ids.map((id) => `<option value="${id}">${escapeHtml(catName(id) || "#" + id)}</option>`).join("");
    if (want && state.selectedCats.has(want)) sel.value = String(want);
  }

  // صور التواصل الاجتماعي
  function renderSocial() {
    document.querySelectorAll(".ed-social-img").forEach((box) => {
      const k = box.dataset.social;
      const v = state.social[k];
      const fallback = (state.featured && state.featured.url) || "";
      const url = (v && v.url) || "";
      box.innerHTML = `<div class="soc-pv ed-drop${url ? "" : " is-empty"}" tabindex="0" data-soc="${k}">${url ? `<img src="${escapeHtml(url)}" alt="" referrerpolicy="no-referrer">` : fallback ? `<img class="is-fallback" src="${escapeHtml(fallback)}" alt="" referrerpolicy="no-referrer"><span>الصورة البارزة (افتراضي)</span>` : "<span>اسحب صورة أو الصقها هنا</span>"}</div>
        <div class="ed-media-actions">${canUpload() ? `<label class="ed-btn ed-btn-ghost ed-btn-sm">رفع صورة<input type="file" accept="image/*" hidden data-soc-file="${k}"></label>` : ""}
        ${url ? `<button type="button" class="ed-btn ed-btn-ghost ed-btn-sm" data-soc-del="${k}">إزالة</button>` : ""}</div>
        <div class="ed-progress hidden"><div></div></div>`;
    });
  }
  async function uploadSocial(k, file) {
    if (!file || !/^image\//.test(file.type || "")) return;
    if (!canUpload()) { toast("صلاحيتك لا تسمح برفع الصور."); return; }
    const box = document.querySelector(`.ed-social-img[data-social="${k}"]`);
    const bar = box.querySelector(".ed-progress");
    bar.classList.remove("hidden");
    state.pendingUploads++; updatePending();
    try {
      const blob = await shrinkImage(file);
      const media = await uploadMedia(blob, "ahwal-social-" + Date.now() + ".jpg", (f) => { bar.firstElementChild.style.width = Math.round(f * 100) + "%"; });
      state.social[k] = { id: media.id, url: media.source_url };
      changed();
    } catch (err) { toast(errMsg(err)); }
    finally { state.pendingUploads--; updatePending(); renderSocial(); }
  }

  // ———————————————————— Yoast: المعاينة والتحليل التقريبي ————————————————————
  function postUrl() {
    if (state.post && state.post.id) return SITE + "/archives/" + state.post.id;
    return SITE + "/archives/…";
  }
  function updateSnippet() {
    const t = seoTitleResolved();
    const d = seoDescEffective();
    const fallbackD = ($("f-excerpt").value.trim() || bodyText()).slice(0, 156);
    $("sn-url").textContent = postUrl().replace(/^https:\/\//, " › ").replace(/\//g, " › ").replace(/^ › ahwal\.sa/, "ahwal.sa");
    $("sn-title").textContent = t.length > 62 ? t.slice(0, 60) + "…" : t || "عنوان الخبر";
    const desc = $("sn-desc");
    desc.textContent = (d ? (d.length > 158 ? d.slice(0, 156) + "…" : d) : fallbackD || "اكتب وصفاً تعريفياً ليظهر هنا.");
    desc.classList.toggle("is-auto", !d);
    const tm = $("title-meter"), dm = $("desc-meter");
    const tl = t.length, dl = d.length;
    tm.style.width = Math.min(100, tl / 60 * 100) + "%";
    tm.className = tl === 0 ? "" : tl < 35 ? "is-short" : tl <= 60 ? "is-ok" : "is-long";
    dm.style.width = Math.min(100, dl / 156 * 100) + "%";
    dm.className = dl === 0 ? "" : dl < 120 ? "is-short" : dl <= 156 ? "is-ok" : "is-long";
    $("seo-title-count").textContent = tl + " / 60";
    $("seo-title-count").className = "ed-counter " + (tl === 0 ? "" : tl <= 60 ? "is-ok" : "is-long");
    const c = $("seo-desc-count");
    c.textContent = dl + " / 156";
    c.className = "ed-counter " + (dl === 0 ? "" : dl < 120 ? "is-short" : dl <= 156 ? "is-ok" : "is-long");
  }
  function analysis() {
    const key = $("f-seo-focus").value.trim();
    const text = bodyText();
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const title = seoTitleResolved();
    const desc = seoDescEffective();
    const slug = $("f-slug").value.trim();
    const root = ed();
    const firstP = Array.from(root.children).find((n) => !n.classList.contains("ed-blk") && n.textContent.trim());
    const intro = firstP ? firstP.textContent : "";
    const imgs = Array.from(root.querySelectorAll(".ed-img, .gal-item")).filter((n) => !n.classList.contains("is-error"));
    const noAlt = imgs.filter((n) => !n.querySelector(".blk-alt").value.trim()).length;
    const links = Array.from(root.querySelectorAll("a[href]")).map((a) => a.getAttribute("href"));
    const internal = links.filter((h) => /^https?:\/\/(www\.)?ahwal\.sa/.test(h)).length;
    const outbound = links.length - internal;
    const heads = root.querySelectorAll("h2,h3,h4").length;
    const c = [];
    const add = (st, txt) => c.push({ st, txt });
    if (!key) add("bad", "لم تُحدَّد كلمة مفتاحية رئيسية.");
    else {
      add(hasKey(title, key) ? (normAr(title).startsWith(normAr(key)) ? "good" : "ok") : "bad",
        hasKey(title, key) ? (normAr(title).startsWith(normAr(key)) ? "الكلمة المفتاحية في بداية عنوان SEO." : "الكلمة المفتاحية في عنوان SEO (الأفضل أن تكون في بدايته).") : "الكلمة المفتاحية غير موجودة في عنوان SEO.");
      add(hasKey(intro, key) ? "good" : "bad", hasKey(intro, key) ? "الكلمة المفتاحية في الفقرة الأولى." : "أضف الكلمة المفتاحية في الفقرة الأولى.");
      add(hasKey(desc, key) ? "good" : "bad", hasKey(desc, key) ? "الكلمة المفتاحية في الوصف التعريفي." : "الكلمة المفتاحية غير موجودة في الوصف التعريفي.");
      if (slug) add(hasKey(slug.replace(/-/g, " "), key) ? "good" : "ok", hasKey(slug.replace(/-/g, " "), key) ? "الكلمة المفتاحية في الاسم اللطيف." : "الاسم اللطيف لا يحتوي الكلمة المفتاحية (أثره بسيط لأن روابط الموقع بالأرقام).");
      if (words >= 50) {
        const k = normAr(key);
        const hay = " " + normAr(text) + " ";
        let n = 0, i = 0;
        while (k && (i = hay.indexOf(k, i)) !== -1) { n++; i += k.length; }
        const dens = n * k.split(" ").length / words * 100;
        add(dens >= 0.5 && dens <= 3 ? "good" : dens > 3 ? "bad" : "ok", `كثافة الكلمة المفتاحية ${dens.toFixed(1)}٪ (${n} مرة). المناسب بين ٠٫٥٪ و٣٪.`);
      }
      if (imgs.length) add(imgs.some((n) => hasKey(n.querySelector(".blk-alt").value, key)) ? "good" : "ok", imgs.some((n) => hasKey(n.querySelector(".blk-alt").value, key)) ? "الكلمة المفتاحية في النص البديل لصورة." : "أضف الكلمة المفتاحية في النص البديل لإحدى الصور.");
    }
    add(words >= 300 ? "good" : words >= 150 ? "ok" : "bad", `طول النص ${words} كلمة. ${words >= 300 ? "ممتاز." : "يُنصح بـ ٣٠٠ كلمة على الأقل."}`);
    add(!desc ? "bad" : desc.length >= 120 && desc.length <= 156 ? "good" : "ok", !desc ? "لا يوجد وصف تعريفي؛ سيختار قوقل جزءاً من النص." : `طول الوصف ${desc.length} حرفاً (المناسب ١٢٠–١٥٦).`);
    add(title.length <= 60 && title.length >= 30 ? "good" : "ok", `طول عنوان SEO ${title.length} حرفاً (المناسب حتى ٦٠ تقريباً).`);
    if (imgs.length) add(noAlt ? "bad" : "good", noAlt ? `${noAlt} من ${imgs.length} صورة بلا نص بديل.` : "كل الصور فيها نص بديل.");
    else add("ok", "لا توجد صور داخل النص.");
    add(state.featured || state.localImage ? "good" : "ok", state.featured || state.localImage ? "توجد صورة بارزة." : "لا توجد صورة بارزة.");
    if (words > 300) add(heads ? "good" : "ok", heads ? "النص مقسّم بعناوين فرعية." : "أضف عناوين فرعية لتقسيم النص الطويل.");
    add(internal ? "good" : "ok", internal ? `روابط داخلية لموقع أحوال: ${internal}.` : "لا توجد روابط لأخبار أخرى في أحوال.");
    add(outbound ? "good" : "ok", outbound ? `روابط خارجية: ${outbound}.` : "لا توجد روابط لمصادر خارجية.");
    if ($("f-noindex").value === "1") add("bad", "الخبر مخفي عن محركات البحث (noindex).");
    return c;
  }
  function renderAnalysis() {
    const c = analysis();
    const ico = { good: "●", ok: "●", bad: "●" };
    $("seo-checks").innerHTML = c.map((x) => `<li class="ck-${x.st}"><i>${ico[x.st]}</i>${escapeHtml(x.txt)}</li>`).join("");
    const good = c.filter((x) => x.st === "good").length;
    const ratio = good / c.length;
    const s = $("seo-score");
    s.className = "ed-score " + (ratio >= 0.7 ? "is-good" : ratio >= 0.45 ? "is-ok" : "is-bad");
    s.textContent = "تقدير تقريبي: " + good + " / " + c.length;
    updateSnippet();
    const wc = bodyText().split(/\s+/).filter(Boolean).length;
    $("word-count").textContent = wc ? wc + " كلمة" : "";
  }
  let anTimer;
  function scheduleAnalysis() { clearTimeout(anTimer); anTimer = setTimeout(renderAnalysis, 350); }

  // ———————————————————— النموذج ————————————————————
  function resetForm() {
    $("post-form").reset();
    ed().innerHTML = "";
    rawStore.clear();
    state.selectedCats = new Set();
    state.featured = null;
    state.localImage = null;
    state.social = { og: null, tw: null };
    state.primaryFromMeta = 0;
    state.slugOrig = "";
    showAlert("form-error", "");
    $("restore-banner").classList.add("hidden");
    setMediaPreview("");
    $("cat-search").value = "";
    fillYoast(null);
    $("f-city").value = localStorage.getItem(CITY_KEY) || "";
    state.datelineTouched = false;
    $("autosave-note").textContent = "";
  }

  function openNew() {
    state.post = null;
    resetForm();
    refreshDateline();
    ensureTail();
    renderCats();
    renderPrimary();
    applyButtons();
    show("form");
    state.dirty = false;
    renderPreview();
    renderAnalysis();
    offerRestore();
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
      let raw = p.content.raw != null ? p.content.raw : p.content.rendered;
      const dm = (raw || "").match(/^\s*<p class="ahwal-dateline"[^>]*>([\s\S]*?)<\/p>\s*/);
      if (dm) { raw = raw.slice(dm[0].length); $("f-dateline").value = decodeEntities(stripHtml(dm[1])); }
      state.datelineTouched = true; // لا نغيّر ترويسة خبر محفوظ إلا بطلب المحرر (زر «تلقائي»)
      const sv = splitVideo(raw);
      loadBody(sv.html);
      $("f-video").value = sv.video;
      try { state.slugOrig = decodeURIComponent(p.slug || ""); } catch (e) { state.slugOrig = p.slug || ""; }
      $("f-slug").value = state.slugOrig;
      state.selectedCats = new Set(p.categories || []);
      const terms = (p._embedded && p._embedded["wp:term"]) || [];
      const tags = (terms.find((g) => g && g[0] && g[0].taxonomy === "post_tag") || []).map((t) => decodeEntities(t.name));
      $("f-tags").value = tags.join("، ");
      const media = p._embedded && p._embedded["wp:featuredmedia"] && p._embedded["wp:featuredmedia"][0];
      if (p.featured_media && media && !media.code) state.featured = { id: p.featured_media, url: bigImageOf(media) };
      else if (p.featured_media) state.featured = { id: p.featured_media, url: "" };
      setMediaPreview(state.featured && state.featured.url);
      fillYoast(p);
      refreshDateline();
      renderCats();
      renderPrimary();
      applyButtons();
      show("form");
      state.dirty = false;
      renderPreview();
      renderAnalysis();
      offerRestore();
    } catch (err) {
      openList();
      showAlert("list-error", errMsg(err));
    }
  }

  function setMediaPreview(url) {
    const box = $("media-preview");
    if (url) { box.classList.remove("is-empty"); box.innerHTML = `<img src="${escapeHtml(url)}" alt="" referrerpolicy="no-referrer">`; }
    else { box.classList.add("is-empty"); box.innerHTML = "<span>لا توجد صورة — اسحب صورة أو الصقها هنا</span>"; }
    $("media-remove").classList.toggle("hidden", !url && !(state.featured && state.featured.id));
    if (state.social) renderSocial();
  }

  async function shrinkImage(file) {
    if (/gif/i.test(file.type)) return file;
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
    if (!canUpload()) { toast("صلاحيتك لا تسمح برفع الصور."); return; }
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
      changed();
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
      renderSocial();
    }
  }
  async function pasteFromClipboard(cb) {
    try {
      if (!navigator.clipboard || !navigator.clipboard.read) throw new Error("no");
      const items = await navigator.clipboard.read();
      for (const it of items) {
        const t = it.types.find((x) => /^image\//.test(x));
        if (t) { const b = await it.getType(t); cb(new File([b], "clipboard." + t.split("/")[1], { type: t })); return; }
      }
      toast("لا توجد صورة في الحافظة.");
    } catch (e) { toast("المتصفح لم يسمح بقراءة الحافظة. اضغط على المربع ثم الصق (Ctrl+V) أو اسحب الصورة."); }
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

  function riyadhToGmt(local) {
    const m = (local || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) return "";
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 3 * 3600e3;
    return new Date(t).toISOString().slice(0, 19);
  }
  function gmtToRiyadhLocal(ms) { return new Date(ms + 3 * 3600e3).toISOString().slice(0, 16); }

  /** الحفظ. opts: { silent, dateGmt } — يعيد المقال المحفوظ أو null */
  async function save(status, opts) {
    opts = opts || {};
    if (state.busy) return null;
    showAlert("form-error", "");
    const title = $("f-title").value.trim();
    const content = buildContent();
    const bodyOnly = serializeBody();
    const video = $("f-video").value.trim();
    if (!title) { showAlert("form-error", "اكتب عنوان الخبر أولاً."); $("f-title").focus(); return null; }
    if (status !== "draft" && !bodyOnly && !video) { showAlert("form-error", "نص الخبر فارغ. اكتب النص أو أضف رابط فيديو."); return null; }
    if (video && !/^https:\/\/\S+$/i.test(video)) { showAlert("form-error", "رابط الفيديو غير صحيح. يجب أن يبدأ بـ https://"); return null; }
    if (state.uploading || state.pendingUploads > 0) { showAlert("form-error", "انتظر حتى يكتمل رفع الصور (" + Math.max(1, state.pendingUploads) + ")."); return null; }
    if (status === "publish" && !state.caps.publish_posts) status = "pending";
    if (status === "publish" && !isLive(state.post) && !opts.silent) {
      const ok = await confirmBox("نشر الخبر", "سيظهر الخبر فوراً في موقع أحوال والتطبيق. هل تريد النشر الآن؟", "نشر الآن", true);
      if (!ok) return null;
    }
    state.busy = true;
    setButtonsBusy(true);
    try {
      const tags = await resolveTags();
      const payload = {
        title,
        excerpt: $("f-excerpt").value.trim(),
        content,
        status: isLive(state.post) && status === "publish" ? state.post.status : status,
        categories: Array.from(state.selectedCats),
        tags: tags.ids,
        featured_media: state.featured ? state.featured.id : 0,
        meta: yoastMetaFromForm(),
      };
      if (opts.dateGmt) payload.date_gmt = opts.dateGmt;
      if (state.post && state.post.status === "future" && status === "publish" && opts.publishNow) { payload.status = "publish"; payload.date_gmt = new Date().toISOString().slice(0, 19); }
      const slug = $("f-slug").value.trim();
      if (slug && slug !== state.slugOrig) payload.slug = slug;
      const path = state.post ? "/posts/" + state.post.id : "/posts";
      let saved;
      let yoastSkipped = false;
      try {
        saved = (await api(path, { method: "POST", body: payload })).data;
      } catch (err) {
        if (!isMetaRejected(err)) throw err;
        const basic = {};
        YOAST_BASIC.forEach((k) => { basic[k] = payload.meta[k]; });
        payload.meta = basic;
        try { saved = (await api(path, { method: "POST", body: payload })).data; }
        catch (err2) { if (!isMetaRejected(err2)) throw err2; delete payload.meta; saved = (await api(path, { method: "POST", body: payload })).data; }
        yoastSkipped = true;
      }
      const sm = saved && saved.meta && !Array.isArray(saved.meta) ? saved.meta : {};
      const missing = YOAST_KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(sm, k));
      const warn = $("yoast-warn");
      if (yoastSkipped || missing.length) {
        const basicMissing = YOAST_BASIC.some((k) => missing.includes(k));
        warn.textContent = basicMissing
          ? "الخبر حُفظ، لكن حقول Yoast لم تُحفظ لأن الموقع لا يسمح بحفظها عبر الواجهة. ارفع إضافة «Ahwal Editor API» الإصدار 1.0.4 ثم احفظ مرة أخرى."
          : "الخبر حُفظ مع العنوان والوصف والكلمة المفتاحية. باقي حقول Yoast (التواصل الاجتماعي، الرابط القانوني، الفهرسة، التصنيف الرئيسي) تحتاج تحديث إضافة «Ahwal Editor API» إلى الإصدار 1.0.4.";
        warn.classList.remove("hidden");
      } else warn.classList.add("hidden");
      saveGalleryAlts();
      clearAutosave();
      if (!state.post) clearAutosave("new");
      state.post = saved;
      try { state.slugOrig = decodeURIComponent(saved.slug || ""); } catch (e) { state.slugOrig = saved.slug || ""; }
      if (saved.slug) $("f-slug").value = state.slugOrig;
      state.dirty = false;
      $("autosave-note").textContent = "محفوظ في الموقع ✓";
      if (!opts.silent) {
        const msg = { publish: "تم النشر ✓", future: "تمت الجدولة ✓", pending: "أُرسل للمراجعة ✓", draft: "حُفظت المسودة ✓", private: "تم الحفظ ✓" }[saved.status] || "تم الحفظ ✓";
        let note = tags.skipped.length ? msg + " — لم تُضف وسوم جديدة: " + tags.skipped.join("، ") : msg;
        if (saved.status === "future") note += " — " + fmtDate(gmtIso(saved, "date"));
        toast(note);
      }
      applyButtons();
      updateSnippet();
      return saved;
    } catch (err) {
      showAlert("form-error", errMsg(err));
      return null;
    } finally {
      state.busy = false;
      setButtonsBusy(false);
    }
  }
  function saveGalleryAlts() {
    if (!canUpload()) return;
    ed().querySelectorAll(".gal-item[data-id]").forEach((it) => {
      const v = it.querySelector(".blk-alt").value.trim();
      if (v !== (it.dataset.altOrig || "")) {
        it.dataset.altOrig = v;
        api("/media/" + it.dataset.id, { method: "POST", body: { alt_text: v } }).catch(() => {});
      }
    });
  }

  function setButtonsBusy(b) { $("form-actions").querySelectorAll("button").forEach((x) => { if (x.id !== "back-btn") x.disabled = b; }); $("btn-trash").disabled = b; }

  async function trash() {
    const p = state.post; if (!p) return;
    const ok = await confirmBox("نقل إلى المهملات", "سيُنقل «" + ($("f-title").value || "هذا المقال") + "» إلى سلة المهملات في الموقع" + (isLive(p) ? " ويختفي من الموقع والتطبيق" : "") + ". يمكن استرجاعه من لوحة ووردبريس خلال ٣٠ يوماً.", "نقل إلى المهملات");
    if (!ok) return;
    setButtonsBusy(true);
    try {
      await api("/posts/" + p.id, { method: "DELETE" });
      state.dirty = false;
      clearAutosave();
      toast("نُقل إلى المهملات");
      openList();
    } catch (err) { showAlert("form-error", errMsg(err)); }
    finally { setButtonsBusy(false); }
  }

  // الجدولة
  function openSchedule() {
    const cur = state.post && state.post.status === "future" ? Date.parse(gmtIso(state.post, "date")) : Date.now() + 3600e3;
    const inp = $("sched-at");
    inp.value = gmtToRiyadhLocal(cur);
    inp.min = gmtToRiyadhLocal(Date.now());
    $("sched-modal").classList.remove("hidden");
  }
  async function doSchedule(e) {
    e.preventDefault();
    const gmt = riyadhToGmt($("sched-at").value);
    if (!gmt || Date.parse(gmt + "Z") < Date.now() + 60e3) { toast("اختر وقتاً في المستقبل."); return; }
    $("sched-modal").classList.add("hidden");
    await save("future", { dateGmt: gmt, silent: false });
  }

  // المعاينة على الموقع: نحفظ المسودة ثم نفتح رابط المعاينة
  async function sitePreview() {
    const w = window.open("about:blank", "_blank");
    if (w) { try { w.document.write('<meta charset="utf-8"><body style="font-family:sans-serif;direction:rtl;padding:40px;color:#333">جاري حفظ المسودة وفتح المعاينة في موقع أحوال…</body>'); } catch (e) { /* */ } }
    let p = state.post;
    if (!p || state.dirty) {
      if (p && isLive(p)) {
        if (w) w.close();
        const ok = await confirmBox("خبر منشور", "هذا الخبر منشور، وحفظ التعديلات يظهر للقرّاء مباشرة. لمعاينة التعديلات قبل نشرها استخدم «معاينة» داخل التطبيق. فتح الخبر المنشور الحالي في الموقع؟", "فتح الخبر", true);
        if (ok) window.open(p.link, "_blank", "noopener");
        return;
      }
      p = await save(p ? p.status : "draft", { silent: true });
      if (!p) { if (w) w.close(); return; }
    }
    let url = isLive(p) && p.status === "publish" ? p.link : SITE + "/?p=" + p.id + "&preview=true";
    let signed = false;
    if (!(isLive(p) && p.status === "publish")) {
      try {
        const { data } = await api(SITE + "/wp-json/ahwal-editor/v1/preview-link/" + p.id, { method: "POST" });
        if (data && data.url && /^https:\/\/(www\.)?ahwal\.sa\//.test(data.url)) { url = data.url; signed = true; }
      } catch (e) { /* الإضافة قديمة: نستخدم معاينة ووردبريس العادية */ }
    }
    if (w) w.location.href = url;
    else showAlert("form-error", "المتصفح منع فتح نافذة جديدة.", "info", ` <a href="${escapeHtml(url)}" target="_blank" rel="noopener">افتح المعاينة</a>`);
    toast(signed ? "فُتحت المعاينة في الموقع (رابط مؤقت لمدة ساعتين)" : "فُتحت المعاينة — تحتاج أن تكون مسجّلاً في موقع أحوال في هذا المتصفح");
  }

  // ———————————————————— المعاينة ————————————————————
  function renderPreview() {
    const title = $("f-title").value.trim() || "عنوان الخبر يظهر هنا";
    let excerpt = $("f-excerpt").value.trim();
    if (!excerpt) { const t = bodyText(); excerpt = t.slice(0, 180) + (t.length > 180 ? "…" : ""); }
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
  function articleHtml() {
    const title = $("f-title").value.trim() || "عنوان الخبر";
    const cat = Array.from(state.selectedCats).map(catName).filter(Boolean)[0] || "";
    const img = state.localImage || (state.featured && state.featured.url) || "";
    const author = (state.me && state.me.name) || "";
    const date = state.post && isLive(state.post) ? gmtIso(state.post, "date") : new Date().toISOString();
    const dl = $("f-dateline").value.trim();
    const body = serializeBody({ preview: true });
    const vid = $("f-video").value.trim();
    const yt = youtubeId(vid);
    const tags = ($("f-tags").value || "").split(/[,،]/).map((s) => s.trim()).filter(Boolean);
    const st = state.post ? state.post.status : "draft";
    return `<article class="pva">
      ${st !== "publish" ? `<div class="pva-note">معاينة — ${escapeHtml(STATUS_AR[st] || "مسودة")}، غير منشور بعد. الشكل تقريبي لصفحة الخبر في الموقع.</div>` : ""}
      ${cat ? `<span class="pva-cat">${escapeHtml(cat)}</span>` : ""}
      <h1>${escapeHtml(title)}</h1>
      <div class="pva-meta">${author ? `<span>${escapeHtml(author)}</span>` : ""}<time>${escapeHtml(fmtDate(date))}</time></div>
      ${img ? `<figure class="pva-hero"><img src="${escapeHtml(img)}" alt="" referrerpolicy="no-referrer"></figure>` : ""}
      <div class="pva-body">
        ${dl ? `<p class="ahwal-dateline">${escapeHtml(dl)}</p>` : ""}
        ${body}
        ${vid ? (yt ? `<div class="pv-embed"><iframe src="https://www.youtube-nocookie.com/embed/${escapeHtml(yt)}" title="فيديو" allowfullscreen loading="lazy"></iframe></div>` : `<p class="pv-embed-link">🎬 <a href="${escapeHtml(vid)}" target="_blank" rel="noopener">${escapeHtml(vid)}</a></p>`) : ""}
      </div>
      ${tags.length ? `<div class="pva-tags">${tags.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>` : ""}
    </article>`;
  }
  function openPreviewModal(tab) {
    renderPreview();
    updateSnippet();
    $("pv-modal").classList.remove("hidden");
    document.body.classList.add("no-scroll");
    setPvTab(tab || "article");
  }
  function setPvTab(tab) {
    $("pv-tabs").querySelectorAll("button").forEach((b) => b.classList.toggle("is-on", b.dataset.pv === tab));
    const body = $("pv-body");
    if (tab === "article") body.innerHTML = articleHtml();
    else if (tab === "card") body.innerHTML = `<div class="ed-phone pv-phone"><div class="ed-phone-screen">${$("preview").innerHTML}</div></div>`;
    else body.innerHTML = `<div class="pv-google"><div class="ed-snippet">${$("snippet").innerHTML}</div><p class="ed-hint">شكل تقريبي لنتيجة البحث. قوقل قد يختار عنواناً أو وصفاً مختلفاً.</p></div>`;
  }
  function closePreviewModal() { $("pv-modal").classList.add("hidden"); $("pv-body").innerHTML = ""; document.body.classList.remove("no-scroll"); }

  // ———————————————————— الحفظ التلقائي على الجهاز ————————————————————
  function autosaveKey(k) { return AUTOSAVE_PREFIX + (k || (state.post ? state.post.id : "new")); }
  function collect() {
    return {
      t: Date.now(),
      modified: state.post ? state.post.modified_gmt || "" : "",
      title: $("f-title").value, excerpt: $("f-excerpt").value, body: serializeBody(),
      city: $("f-city").value, dateline: $("f-dateline").value, datelineTouched: !!state.datelineTouched,
      video: $("f-video").value, tags: $("f-tags").value, cats: Array.from(state.selectedCats), primary: $("f-primary-cat").value,
      featured: state.featured, social: state.social, slug: $("f-slug").value, meta: yoastMetaFromForm(),
    };
  }
  let asTimer;
  function scheduleAutosave() {
    clearTimeout(asTimer);
    asTimer = setTimeout(() => {
      if ($("view-form").hidden || !state.dirty) return;
      try {
        localStorage.setItem(autosaveKey(), JSON.stringify(collect()));
        if (!state.pendingUploads) $("autosave-note").textContent = "نسخة على الجهاز " + new Intl.DateTimeFormat("ar-SA", { timeZone: TZ, hour: "numeric", minute: "2-digit" }).format(new Date());
      } catch (e) { /* مساحة التخزين ممتلئة */ }
    }, 1200);
  }
  function clearAutosave(k) { try { localStorage.removeItem(autosaveKey(k)); } catch (e) { /* */ } }
  function offerRestore() {
    let a = null;
    try { a = JSON.parse(localStorage.getItem(autosaveKey()) || "null"); } catch (e) { a = null; }
    const banner = $("restore-banner");
    if (!a || !a.t) { banner.classList.add("hidden"); return; }
    const cur = JSON.stringify([$("f-title").value, serializeBody()]);
    if (JSON.stringify([a.title, a.body]) === cur) { banner.classList.add("hidden"); return; }
    const when = new Intl.DateTimeFormat("ar-SA", { timeZone: TZ, day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(new Date(a.t));
    const newer = state.post && a.modified && state.post.modified_gmt && a.modified !== state.post.modified_gmt;
    banner.innerHTML = `توجد نسخة غير محفوظة من هذا الخبر على هذا الجهاز (${escapeHtml(when)})${newer ? " — تنبيه: الخبر عُدّل في الموقع بعدها" : ""}. <button type="button" class="ed-btn ed-btn-ghost ed-btn-sm" id="restore-yes">استعادة</button> <button type="button" class="ed-btn ed-btn-ghost ed-btn-sm" id="restore-no">تجاهل</button>`;
    banner.classList.remove("hidden");
    $("restore-yes").onclick = () => { applyAutosave(a); banner.classList.add("hidden"); };
    $("restore-no").onclick = () => { clearAutosave(); banner.classList.add("hidden"); };
  }
  function applyAutosave(a) {
    $("f-title").value = a.title || "";
    $("f-excerpt").value = a.excerpt || "";
    loadBody(a.body || "");
    $("f-city").value = a.city || "";
    $("f-dateline").value = a.dateline || "";
    state.datelineTouched = !!a.datelineTouched;
    $("f-video").value = a.video || "";
    $("f-tags").value = a.tags || "";
    state.selectedCats = new Set(a.cats || []);
    state.featured = a.featured || null;
    state.social = a.social || { og: null, tw: null };
    $("f-slug").value = a.slug || "";
    fillYoast({ meta: a.meta || {} });
    state.social = a.social || { og: null, tw: null };
    state.primaryFromMeta = parseInt(a.primary, 10) || 0;
    setMediaPreview(state.featured && state.featured.url);
    refreshDateline();
    renderCats(); renderPrimary(); renderSocial();
    changed();
    toast("تمت استعادة النسخة المحفوظة على الجهاز");
  }

  /** أي تغيير في النموذج */
  function changed() {
    state.dirty = true;
    ensureTail();
    clearTimeout(pvTimer); pvTimer = setTimeout(renderPreview, 250);
    scheduleAnalysis();
    scheduleAutosave();
  }
  let pvTimer;
  function schedulePreview() { changed(); }

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

  // ———————————————————— الأحداث ————————————————————
  function bindDrop(el, onFiles) {
    el.addEventListener("dragover", (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) { e.preventDefault(); el.classList.add("is-drag"); } });
    el.addEventListener("dragleave", () => el.classList.remove("is-drag"));
    el.addEventListener("drop", (e) => { const f = imageFiles(e.dataTransfer && e.dataTransfer.files); el.classList.remove("is-drag"); if (f.length) { e.preventDefault(); onFiles(f); } });
    el.addEventListener("paste", (e) => {
      const f = imageFiles(Array.from((e.clipboardData && e.clipboardData.items) || []).filter((i) => i.kind === "file").map((i) => i.getAsFile()));
      if (f.length) { e.preventDefault(); onFiles(f); }
    });
  }
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
      if (state.dirty && !(await confirmBox("تغييرات غير محفوظة في الموقع", "تعديلاتك محفوظة كنسخة على هذا الجهاز ويمكن استعادتها لاحقاً، لكنها لم تُحفظ في الموقع. تريد الخروج؟", "خروج"))) return;
      state.dirty = false;
      openList();
    });
    $("form-actions").addEventListener("click", (e) => {
      const b = e.target.closest("button"); if (!b || b.id === "back-btn") return;
      if (b.dataset.save) save(b.dataset.save).then((s) => { if (s && s.status === "publish" && b.dataset.save === "publish") setTimeout(openList, 900); });
      else if (b.id === "btn-preview") openPreviewModal("article");
      else if (b.id === "btn-site") sitePreview();
      else if (b.id === "btn-schedule") openSchedule();
    });
    $("btn-trash").addEventListener("click", trash);
    $("sched-form").addEventListener("submit", doSchedule);
    $("sched-cancel").addEventListener("click", () => $("sched-modal").classList.add("hidden"));
    $("pv-close").addEventListener("click", closePreviewModal);
    $("pv-site").addEventListener("click", () => { closePreviewModal(); sitePreview(); });
    $("pv-tabs").addEventListener("click", (e) => { const b = e.target.closest("[data-pv]"); if (b) setPvTab(b.dataset.pv); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("pv-modal").classList.contains("hidden")) closePreviewModal(); });

    $("f-cats").addEventListener("click", (e) => {
      const b = e.target.closest("[data-cat]"); if (!b || $("cat-search").disabled) return;
      const id = parseInt(b.dataset.cat, 10);
      if (state.selectedCats.has(id)) state.selectedCats.delete(id); else state.selectedCats.add(id);
      b.classList.toggle("is-on");
      renderPrimary();
      changed();
    });
    $("cat-search").addEventListener("input", renderCats);
    ["f-title", "f-excerpt", "f-video", "f-tags", "f-seo-title", "f-seo-desc", "f-seo-focus", "f-slug", "f-canonical", "f-og-title", "f-og-desc", "f-tw-title", "f-tw-desc", "f-primary-cat", "f-noindex", "f-nofollow", "f-cornerstone"]
      .forEach((id) => $(id).addEventListener(/^(f-primary-cat|f-noindex|f-nofollow|f-cornerstone)$/.test(id) ? "change" : "input", changed));

    // الترويسة
    $("cities").innerHTML = CITIES.map((c) => `<option value="${escapeHtml(c)}">`).join("");
    $("f-city").addEventListener("input", () => { localStorage.setItem(CITY_KEY, $("f-city").value.trim()); refreshDateline(); changed(); });
    $("f-dateline").addEventListener("input", () => { state.datelineTouched = true; refreshDateline(); changed(); });
    $("dateline-auto").addEventListener("click", () => { state.datelineTouched = false; refreshDateline(); changed(); });

    // تبويبات Yoast
    document.querySelector(".ed-seo-tabs").addEventListener("click", (e) => {
      const b = e.target.closest("[data-seotab]"); if (!b) return;
      b.parentNode.querySelectorAll("button").forEach((x) => x.classList.toggle("is-on", x === b));
      document.querySelectorAll(".ed-seo-pane").forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== b.dataset.seotab));
      if (b.dataset.seotab === "analysis") renderAnalysis();
    });
    document.querySelector(".ed-vars").addEventListener("click", (e) => {
      const b = e.target.closest("[data-var]"); if (!b) return;
      const inp = $("f-seo-title");
      const v = inp.value;
      const pos = inp.selectionStart != null ? inp.selectionStart : v.length;
      const ins = (pos > 0 && v[pos - 1] !== " " ? " " : "") + b.dataset.var + " ";
      inp.value = v.slice(0, pos) + ins + v.slice(pos);
      inp.focus(); changed();
    });
    // صور التواصل
    const yb = $("yoast-box");
    yb.addEventListener("change", (e) => { const k = e.target.dataset && e.target.dataset.socFile; if (k) { const f = e.target.files && e.target.files[0]; e.target.value = ""; uploadSocial(k, f); } });
    yb.addEventListener("click", (e) => { const b = e.target.closest("[data-soc-del]"); if (b) { state.social[b.dataset.socDel] = null; renderSocial(); changed(); } });
    yb.addEventListener("dragover", (e) => { if (e.target.closest(".soc-pv")) e.preventDefault(); });
    yb.addEventListener("drop", (e) => { const z = e.target.closest(".soc-pv"); if (!z) return; const f = imageFiles(e.dataTransfer.files); if (f.length) { e.preventDefault(); uploadSocial(z.dataset.soc, f[0]); } });
    yb.addEventListener("paste", (e) => {
      const z = e.target.closest && e.target.closest(".soc-pv"); if (!z) return;
      const f = imageFiles(Array.from((e.clipboardData && e.clipboardData.items) || []).filter((i) => i.kind === "file").map((i) => i.getAsFile()));
      if (f.length) { e.preventDefault(); uploadSocial(z.dataset.soc, f[0]); }
    });

    // المحرر
    const body = ed();
    try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch (e) { /* قديم */ }
    body.addEventListener("input", (e) => {
      if (e.target && e.target.classList && e.target.classList.contains("blk-alt")) {
        const im = e.target.closest(".ed-img"); if (im) im.querySelector("img").alt = e.target.value;
      }
      changed();
    });
    body.addEventListener("focus", () => { if (!body.firstChild) { body.appendChild(emptyP()); caretInto(body.firstChild); } });
    document.addEventListener("selectionchange", keepSelection);
    body.addEventListener("paste", onPaste);
    body.addEventListener("dragstart", (e) => { dragSrc = e.target; });
    body.addEventListener("dragend", () => { dragSrc = null; });
    body.addEventListener("dragover", (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) { e.preventDefault(); body.classList.add("is-drag"); } });
    body.addEventListener("dragleave", (e) => { if (e.target === body) body.classList.remove("is-drag"); });
    body.addEventListener("drop", onDrop);
    body.addEventListener("click", onBlockAction);
    body.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.closest && (e.target.closest("figcaption") || e.target.closest(".blk-alt"))) e.preventDefault();
    });
    $("toolbar").addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
    $("toolbar").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-cmd]"); if (!b) return;
      runCmd(b.dataset.cmd);
    });
    $("f-body-img").addEventListener("change", (e) => { const f = Array.from(e.target.files || []); e.target.value = ""; insertImageFiles(f); });
    $("f-gal-img").addEventListener("change", (e) => {
      const f = imageFiles(e.target.files); e.target.value = "";
      if (!f.length) return;
      if (galTarget && galTarget.isConnected) addToGallery(galTarget, f);
      else if (!canUpload()) toast("صلاحيتك لا تسمح برفع الصور.");
      else { const g = makeGalleryBlock([], ""); insertBlocks([g]); addToGallery(g, f); }
      galTarget = null;
    });

    // الصورة البارزة
    const onFile = (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ""; handleFile(f); };
    $("f-camera").addEventListener("change", onFile);
    $("f-gallery").addEventListener("change", onFile);
    bindDrop($("media-preview"), (f) => handleFile(f[0]));
    $("media-paste").addEventListener("click", () => pasteFromClipboard(handleFile));
    $("media-remove").addEventListener("click", () => { state.featured = null; state.localImage = null; setMediaPreview(""); changed(); });

    window.addEventListener("beforeunload", (e) => { if ((state.dirty || state.pendingUploads) && !$("view-form").hidden) { e.preventDefault(); e.returnValue = ""; } });
  }

  state.social = { og: null, tw: null };
  bind();
  if (returnNotice) renderLogin(returnNotice);
  if (state.auth) connect(); else if (!returnNotice) renderLogin();
})();
