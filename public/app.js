const statusLine = document.getElementById("statusLine");
const matchForm = document.getElementById("matchForm");
const participantSelect = document.getElementById("participantSelect");
const matchTab = document.getElementById("matchTab");
const result = document.getElementById("result");
const errorBox = document.getElementById("error");
const nameList = document.getElementById("nameList");
const emptyRoster = document.getElementById("emptyRoster");
const rosterSummary = document.getElementById("rosterSummary");
const rosterCount = document.getElementById("rosterCount");
const matchEmpty = document.getElementById("matchEmpty");
const tabs = [...document.querySelectorAll('[role="tab"]:not(:disabled)')];
const panels = [...document.querySelectorAll('[role="tabpanel"]')];
const basketId = location.pathname.match(/^\/b\/([A-Za-z0-9_-]{10})\/?$/)?.[1]
  || new URLSearchParams(location.search).get("basket");
const createPanel = document.getElementById("createPanel");
const joinPanel = document.getElementById("joinPanel");
const sharePanel = document.getElementById("sharePanel");
const drawTabs = document.getElementById("drawTabs");
const basketTools = document.getElementById("basketTools");
const launchButton = document.getElementById("launchButton");
document.getElementById("refreshButton").addEventListener("click", refreshStatus);

function displayBasket() {
  createPanel.hidden = true;
  joinPanel.hidden = false;
}

function enableDraw(data) {
  const joined = sessionStorage.getItem(`santa-joined-${basketId}`) === "1";
  const created = new URLSearchParams(location.search).has("created");
  joinPanel.hidden = data.launched || joined || created;
  drawTabs.hidden = !data.launched && !joined && !created;
  basketTools.hidden = false;
  document.getElementById("basketMeta").textContent = `${data.basket.hostName}’s basket · ${data.total} of ${data.basket.capacity} joined`;
  document.getElementById("lede").textContent = data.launched
    ? `A Secret Santa hosted by ${data.basket.hostName}.`
    : `Join ${data.basket.hostName}’s basket and add your name before the draw launches.`;
  const secret = sessionStorage.getItem(`santa-host-${basketId}`);
  const full = data.total >= data.basket.capacity;
  launchButton.hidden = !secret || data.launched;
  launchButton.disabled = !full;
  launchButton.textContent = full ? "Launch the draw" : `Waiting for ${data.basket.capacity - data.total} more`;
  document.getElementById("joinCopy").textContent = data.launched
    ? `${data.basket.hostName} has launched the draw.`
    : full
      ? `This basket is full. ${data.basket.hostName} can launch the draw now.`
      : `${data.basket.hostName} is hosting. ${data.total} of ${data.basket.capacity} places filled.`;
  document.getElementById("joinHeading").textContent = data.launched ? "The draw is open" : full ? "Basket is full" : "Join the basket";
  document.getElementById("joinForm").hidden = data.launched || joined || full;
  if (data.launched) statusLine.textContent = data.drawn ? "All matches are complete" : "The draw is open";
}

function activateTab(tab, focus = false) {
  const panelId = tab.getAttribute("aria-controls");
  tabs.forEach((item) => {
    const selected = item === tab;
    item.classList.toggle("is-active", selected);
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  });
  panels.forEach((panel) => {
    panel.hidden = panel.id !== panelId;
  });
  if (focus) tab.focus();
}

function showError(message) {
  errorBox.hidden = !message;
  errorBox.textContent = message || "";
  if (message) {
    errorBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function showMatch(matchName, personName = "") {
  result.hidden = false;
  result.innerHTML = `<article class="ticket paired"><p>Your Secret Santa match</p><h3>${escapeHtml(matchName)}</h3>${personName ? `<p class="ticket-owner">Drawing as ${escapeHtml(personName)}</p>` : ""}</article>`;
  result.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function readJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || "Something went wrong.");
  }
  return data;
}

function renderRoster(names) {
  nameList.replaceChildren();
  emptyRoster.hidden = names.length > 0;
  names.forEach((person) => {
    const item = document.createElement("li");
    item.textContent = person.name;
    nameList.append(item);
  });
  rosterCount.textContent = String(names.length);
  rosterCount.setAttribute("aria-label", `${names.length} ${names.length === 1 ? "person" : "people"} in the draw`);
  rosterSummary.textContent = `${names.length} ${names.length === 1 ? "person" : "people"} in the draw`;
}

function renderAvailableNames(names) {
  participantSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.textContent = names.length ? "Select your name" : "No names left to match";
  participantSelect.append(placeholder);
  names.forEach((person) => {
    const option = document.createElement("option");
    option.value = person.id;
    option.textContent = person.name;
    participantSelect.append(option);
  });
  matchForm.querySelector("button").disabled = names.length === 0;
  matchEmpty.hidden = names.length > 0;
}

async function refreshStatus() {
  if (!basketId) return;
  try {
    const data = await readJson(await fetch(`/api/status?basket=${encodeURIComponent(basketId)}`));
    enableDraw(data);
    if (!data.launched) {
      statusLine.textContent = data.total === data.basket.capacity
        ? "All places filled · waiting for host"
        : `Waiting for ${data.basket.capacity - data.total} more people`;
      rosterSummary.textContent = `${data.total} of ${data.basket.capacity} places filled`;
      renderRoster(data.names || []);
      return;
    }
    const names = data.names || [];
    const availableNames = data.availableNames || [];
    statusLine.textContent = data.drawn
      ? "All matches are complete"
      : `${data.total} ${data.total === 1 ? "person" : "people"} in the draw`;
    renderRoster(names);
    renderAvailableNames(availableNames);
    const sessionMatch = data.sessionMatch || {};
    if (sessionMatch.matched) {
      showMatch(sessionMatch.matchName, sessionMatch.personName);
      matchForm.hidden = true;
      matchEmpty.hidden = true;
      activateTab(matchTab);
    } else if (data.drawn) {
      matchForm.hidden = true;
      matchEmpty.hidden = false;
      result.hidden = true;
    } else {
      matchForm.hidden = false;
      result.hidden = true;
    }
  } catch {
    statusLine.textContent = "Could not load the draw";
    rosterSummary.textContent = "The roster could not be loaded.";
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab));
  tab.addEventListener("keydown", (event) => {
    const currentIndex = tabs.indexOf(tab);
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    activateTab(tabs[nextIndex], true);
  });
});

participantSelect.addEventListener("change", () => {
  result.hidden = true;
  showError("");
});

matchForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  const personId = String(new FormData(matchForm).get("personId") || "").trim();
  const button = matchForm.querySelector("button");
  button.disabled = true;
  try {
    const data = await readJson(
      await fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personId, basket: basketId }),
      })
    );
    participantSelect.value = "";
    showMatch(data.matchName);
    activateTab(matchTab);
    await refreshStatus();
  } catch (err) {
    showError(err.message);
    button.disabled = false;
  }
});

document.getElementById("createForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    const data = await readJson(await fetch("/api/baskets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) }));
    sessionStorage.setItem(`santa-host-${data.publicCode}`, data.hostSecret);
    location.href = `/b/${encodeURIComponent(data.publicCode)}?created=1`;
  } catch (err) {
    const box = document.getElementById("createError"); box.hidden = false; box.textContent = err.message; button.disabled = false;
  }
});

document.getElementById("joinForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button"); button.disabled = true;
  try {
    await readJson(await fetch("/api/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ basket: basketId, name: new FormData(form).get("name") }) }));
    sessionStorage.setItem(`santa-joined-${basketId}`, "1");
    await refreshStatus();
  } catch (err) {
    const box = document.getElementById("joinError"); box.hidden = false; box.textContent = err.message; button.disabled = false;
  }
});

launchButton.addEventListener("click", async () => {
  launchButton.disabled = true;
  try {
    await readJson(await fetch("/api/launch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ basket: basketId, hostSecret: sessionStorage.getItem(`santa-host-${basketId}`) }) }));
    await refreshStatus();
  } catch (err) {
    const box = document.getElementById("launchError"); box.hidden = false; box.textContent = err.message; launchButton.disabled = false;
  }
});

document.getElementById("copyLink").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(document.getElementById("shareLink").value); document.getElementById("copyLink").textContent = "Invite link copied"; }
  catch { document.getElementById("shareError").textContent = "Copy isn’t available here. Select and copy the link above."; document.getElementById("shareError").hidden = false; }
});

if (!basketId) {
  statusLine.textContent = "Start a new draw";
  createPanel.hidden = false;
  document.getElementById("rosterPanel").hidden = true;
}
else {
  displayBasket();
  if (new URLSearchParams(location.search).has("created")) {
    joinPanel.hidden = true; sharePanel.hidden = false;
    document.getElementById("shareLink").value = `${location.origin}/b/${encodeURIComponent(basketId)}`;
  }
}
refreshStatus();
