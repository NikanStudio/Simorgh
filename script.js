const SUPABASE_URL =
  "https://lsjytkjrjdjfnizjldcp.supabase.co";

const SUPABASE_KEY =
  "sb_publishable_B9wl54kGsWnYRvXiqzqDew_Yb86ssiR";

const AUTH_URL =
  SUPABASE_URL + "/functions/v1/simorg-auth";

const ADMIN_USERNAME = "simorgh";

const db = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_KEY
);

let currentUser = null;
let currentProfile = null;
let activeConversation = null;
let activePartner = null;
let chats = [];
let poller = null;
let mode = "login";

const $ = id => document.getElementById(id);

function status(message, error = false) {
  const el = $("chatStatus");
  el.textContent = message;
  el.style.color = error ? "#ff9999" : "#b9a2ff";
}

function showPage(page) {
  $("authPage").classList.toggle("hidden", page !== "auth");
  $("messenger").classList.toggle("hidden", page !== "messenger");
  $("logoutBtn").classList.toggle("hidden", page !== "messenger");
}

function isAdmin(profile) {
  return profile &&
    (profile.is_admin === true ||
     profile.username?.toLowerCase() === ADMIN_USERNAME);
}

function storageKey() {
  return "simorg_names_" + currentUser.id;
}

function getNames() {
  try {
    return JSON.parse(localStorage.getItem(storageKey()) || "{}");
  } catch {
    return {};
  }
}

function displayName(profile) {
  if (isAdmin(profile)) return "ادمین رسمی سیمرغ";

  const names = getNames();

  return names[profile.id] ||
    profile.display_name ||
    profile.username;
}

function renameContact(profile) {
  if (isAdmin(profile)) return;

  const name = prompt(
    "اسم دلخواه این مخاطب:",
    displayName(profile)
  );

  if (name === null) return;

  if (!name.trim()) {
    alert("اسم نمی‌تواند خالی باشد.");
    return;
  }

  const names = getNames();
  names[profile.id] = name.trim();

  localStorage.setItem(storageKey(), JSON.stringify(names));

  renderChats();

  if (activePartner?.id === profile.id) {
    $("partnerName").textContent = displayName(profile);
    $("partnerAvatar").textContent = displayName(profile).slice(0, 1);
  }
}

function setMode(value) {
  mode = value;

  $("loginTab").classList.toggle("selected", mode === "login");
  $("signupTab").classList.toggle("selected", mode === "signup");
  $("confirmBox").classList.toggle("hidden", mode !== "signup");
  $("confirmPassword").required = mode === "signup";

  $("authSubmit").textContent =
    mode === "login" ? "ورود به سیمرغ" : "ساخت حساب";

  $("authMessage").textContent = "";
}

$("loginTab").onclick = () => setMode("login");
$("signupTab").onclick = () => setMode("signup");

$("authForm").addEventListener("submit", async e => {
  e.preventDefault();

  const username = $("username").value.trim().toLowerCase();
  const password = $("password").value;
  const confirmPassword = $("confirmPassword").value;

  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    $("authMessage").textContent =
      "آیدی باید ۳ تا ۲۴ حرف انگلیسی، عدد یا زیرخط باشد.";
    return;
  }

  if (password.length < 8) {
    $("authMessage").textContent =
      "رمز باید حداقل ۸ کاراکتر باشد.";
    return;
  }

  if (mode === "signup" && password !== confirmPassword) {
    $("authMessage").textContent = "تکرار رمز یکسان نیست.";
    return;
  }

  $("authSubmit").disabled = true;
  $("authMessage").textContent = "لطفاً صبر کن...";

  try {
    const response = await fetch(AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": SUPABASE_KEY
      },
      body: JSON.stringify({
        action: mode === "login" ? "login" : "signup",
        username,
        password,
        confirmPassword
      })
    });

    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "عملیات ناموفق بود.");
    }

    const { error } = await db.auth.setSession({
      access_token: result.access_token,
      refresh_token: result.refresh_token
    });

    if (error) throw error;

    await loadApp();

  } catch (error) {
    $("authMessage").textContent = error.message;
  } finally {
    $("authSubmit").disabled = false;
    $("authSubmit").textContent =
      mode === "login" ? "ورود به سیمرغ" : "ساخت حساب";
  }
});

async function loadApp() {
  const { data, error } = await db.auth.getUser();

  if (error || !data.user) {
    showPage("auth");
    return;
  }

  currentUser = data.user;

  const result = await db
    .from("profiles")
    .select("id, username, display_name, avatar_url, is_admin")
    .eq("id", currentUser.id)
    .single();

  if (result.error) {
    showPage("auth");
    $("authMessage").textContent = result.error.message;
    return;
  }

  currentProfile = result.data;

  $("myName").textContent =
    currentProfile.display_name || currentProfile.username;

  $("myUsername").textContent =
    "@" + currentProfile.username;

  $("myAvatar").textContent =
    (currentProfile.display_name || "س").slice(0, 1);

  showPage("messenger");

  await loadChats();

  if (poller) clearInterval(poller);

  poller = setInterval(async () => {
    await loadChats();

    if (activeConversation) {
      await loadMessages();
    }
  }, 3000);
}

async function loadChats() {
  if (!currentUser || !currentProfile) return;

  try {
    const membership = await db
      .from("conversation_members")
      .select("conversation_id")
      .eq("user_id", currentUser.id);

    if (membership.error) throw membership.error;

    const ids = [
      ...new Set(membership.data.map(x => x.conversation_id))
    ];

    let members = [];
    let profiles = [];

    if (ids.length) {
      const memberResult = await db
        .from("conversation_members")
        .select("conversation_id, user_id")
        .in("conversation_id", ids);

      if (memberResult.error) throw memberResult.error;

      members = memberResult.data;

      const partnerIds = [
        ...new Set(
          members
            .filter(x => x.user_id !== currentUser.id)
            .map(x => x.user_id)
        )
      ];

      if (partnerIds.length) {
        const profileResult = await db
          .from("profiles")
          .select("id, username, display_name, avatar_url, is_admin")
          .in("id", partnerIds);

        if (profileResult.error) throw profileResult.error;

        profiles = profileResult.data;
      }
    }

    const resultChats = [];

    for (const id of ids) {
      const group = members.filter(x => x.conversation_id === id);

      if (group.length !== 2) continue;

      const partnerId = group.find(
        x => x.user_id !== currentUser.id
      )?.user_id;

      const profile = profiles.find(x => x.id === partnerId);

      if (profile) {
        resultChats.push({ id, profile });
      }
    }

    if (isAdmin(currentProfile)) {
      const all = await db
        .from("profiles")
        .select("id, username, display_name, avatar_url, is_admin")
        .neq("id", currentUser.id);

      if (all.error) throw all.error;

      for (const profile of all.data) {
        if (!resultChats.some(x => x.profile.id === profile.id)) {
          resultChats.push({ id: null, profile });
        }
      }
    } else {
      const admin = await db
        .from("profiles")
        .select("id, username, display_name, avatar_url, is_admin")
        .eq("username", ADMIN_USERNAME)
        .maybeSingle();

      if (admin.error) throw admin.error;

      if (admin.data &&
          !resultChats.some(x => x.profile.id === admin.data.id)) {
        resultChats.unshift({
          id: null,
          profile: admin.data
        });
      }
    }

    chats = resultChats;

    if (isAdmin(currentProfile)) {
      chats.sort((a, b) =>
        displayName(a.profile).localeCompare(displayName(b.profile))
      );
    } else {
      chats.sort((a, b) =>
        Number(isAdmin(b.profile)) - Number(isAdmin(a.profile))
      );
    }

    renderChats();

  } catch (error) {
    status("خطا در دریافت فهرست: " + error.message, true);
  }
}

function renderChats() {
  const list = $("chatList");
  list.replaceChildren();

  if (!chats.length) {
    const p = document.createElement("p");
    p.className = "status";
    p.textContent = "هنوز کاربری وجود ندارد.";
    list.appendChild(p);
    return;
  }

  for (const chat of chats) {
    const button = document.createElement("button");
    button.className = "chat-item";

    if (chat.id && chat.id === activeConversation) {
      button.classList.add("selected");
    }

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = displayName(chat.profile).slice(0, 1);

    const info = document.createElement("div");
    info.className = "chat-item-info";

    const name = document.createElement("strong");
    name.textContent = displayName(chat.profile);

    const username = document.createElement("small");
    username.textContent = "@" + chat.profile.username;

    info.append(name, username);
    button.append(avatar, info);

    if (!isAdmin(chat.profile)) {
      const edit = document.createElement("button");
      edit.className = "rename-btn";
      edit.type = "button";
      edit.textContent = "✎";
      edit.title = "تغییر نام";

      edit.onclick = e => {
        e.stopPropagation();
        renameContact(chat.profile);
      };

      button.appendChild(edit);
    }

    button.onclick = () => openOrCreateChat(chat.profile);

    list.appendChild(button);
  }
}

$("searchBtn").onclick = searchUsers;

$("searchInput").addEventListener("keydown", e => {
  if (e.key === "Enter") searchUsers();
});

async function searchUsers() {
  const username = $("searchInput").value.trim().toLowerCase();
  const results = $("searchResults");

  results.replaceChildren();

  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    results.textContent = "آیدی معتبر وارد کن.";
    return;
  }

  if (username === currentProfile.username) {
    results.textContent = "این آیدی متعلق به خودته.";
    return;
  }

  $("searchBtn").disabled = true;

  try {
    const result = await db
      .from("profiles")
      .select("id, username, display_name, avatar_url, is_admin")
      .eq("username", username)
      .maybeSingle();

    if (result.error) throw result.error;

    if (!result.data) {
      results.textContent = "کاربری پیدا نشد.";
      return;
    }

    const button = document.createElement("button");
    button.className = "result-item";

    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = displayName(result.data).slice(0, 1);

    const info = document.createElement("div");
    info.className = "chat-item-info";

    const name = document.createElement("strong");
    name.textContent = displayName(result.data);

    const id = document.createElement("small");
    id.textContent = "@" + result.data.username;

    info.append(name, id);
    button.append(avatar, info);

    button.onclick = () => openOrCreateChat(result.data);

    results.appendChild(button);

  } catch (error) {
    results.textContent = "خطا: " + error.message;
  } finally {
    $("searchBtn").disabled = false;
  }
}

async function openOrCreateChat(profile) {
  try {
    if (!profile || !profile.id) {
      throw new Error("اطلاعات حساب ناقص است.");
    }

    if (profile.id === currentUser.id) {
      throw new Error("نمی‌توانی با خودت چت بسازی.");
    }

    status("در حال بازکردن گفت‌وگو...");

    await loadChats();

    const existing = chats.find(
      x => x.profile.id === profile.id && x.id
    );

    if (existing) {
      await openChat(existing.id, profile);
      status("");
      return;
    }

    const conversation = await db
      .from("conversations")
      .insert({
        created_by: currentUser.id,
        conversation_type: "private"
      })
      .select("id")
      .single();

    if (conversation.error) {
      throw conversation.error;
    }

    const conversationId = conversation.data.id;

    const members = await db
      .from("conversation_members")
      .insert([
        {
          conversation_id: conversationId,
          user_id: currentUser.id
        },
        {
          conversation_id: conversationId,
          user_id: profile.id
        }
      ]);

    if (members.error) {
      throw members.error;
    }

    await openChat(conversationId, profile);
    await loadChats();

    status("");

  } catch (error) {
    console.error(error);
    status("خطا در بازکردن چت: " + error.message, true);
    alert("بازکردن چت ناموفق بود:\n" + error.message);
  }
}

async function openChat(id, profile) {
  activeConversation = id;
  activePartner = profile;

  $("emptyChat").classList.add("hidden");
  $("activeChat").classList.remove("hidden");

  $("partnerName").textContent = displayName(profile);
  $("partnerUsername").textContent = "@" + profile.username;
  $("partnerAvatar").textContent = displayName(profile).slice(0, 1);

  renderChats();
  await loadMessages();
}

async function loadMessages() {
  if (!activeConversation) return;

  const result = await db
    .from("messages")
    .select("id, conversation_id, sender_id, body, created_at")
    .eq("conversation_id", activeConversation)
    .order("created_at", { ascending: true })
    .limit(200);

  if (result.error) {
    status("خطای دریافت پیام: " + result.error.message, true);
    return;
  }

  renderMessages(result.data || []);
}

function renderMessages(items) {
  const box = $("messages");
  box.replaceChildren();

  for (const item of items) {
    const message = document.createElement("div");

    message.className =
      "message " +
      (item.sender_id === currentUser.id ? "mine" : "theirs");

    const body = document.createElement("div");
    body.textContent = item.body;

    const time = document.createElement("small");
    time.className = "message-time";

    time.textContent = new Date(item.created_at)
      .toLocaleTimeString("fa-IR", {
        hour: "2-digit",
        minute: "2-digit"
      });

    message.append(body, time);
    box.appendChild(message);
  }

  box.scrollTop = box.scrollHeight;
}

$("sendForm").addEventListener("submit", async e => {
  e.preventDefault();

  const body = $("messageInput").value.trim();

  if (!body || !activeConversation) return;

  $("messageInput").disabled = true;

  try {
    const result = await db
      .from("messages")
      .insert({
        conversation_id: activeConversation,
        sender_id: currentUser.id,
        body
      });

    if (result.error) throw result.error;

    $("messageInput").value = "";
    await loadMessages();

  } catch (error) {
    status("ارسال پیام ناموفق بود: " + error.message, true);
  } finally {
    $("messageInput").disabled = false;
    $("messageInput").focus();
  }
});

$("logoutBtn").onclick = async () => {
  if (poller) clearInterval(poller);

  await db.auth.signOut();

  currentUser = null;
  currentProfile = null;
  activeConversation = null;
  activePartner = null;
  chats = [];

  showPage("auth");
};

async function start() {
  showPage("auth");

  const result = await db.auth.getSession();

  if (result.data.session) {
    await loadApp();
  }
}

start();
