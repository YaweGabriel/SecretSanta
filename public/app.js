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
  try {
    const data = await readJson(await fetch("/api/status"));
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
        body: JSON.stringify({ personId }),
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

refreshStatus();
