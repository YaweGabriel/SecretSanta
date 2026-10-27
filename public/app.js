const statusLine = document.getElementById("statusLine");
const matchForm = document.getElementById("matchForm");
const participantSelect = document.getElementById("participantSelect");
const result = document.getElementById("result");
const errorBox = document.getElementById("error");
const nameList = document.getElementById("nameList");
const emptyRoster = document.getElementById("emptyRoster");

function showError(message) {
  errorBox.hidden = !message;
  errorBox.textContent = message || "";
  if (message) {
    errorBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function showMatch(matchName) {
  result.hidden = false;
  result.innerHTML = `<article class="ticket paired"><p>Your Secret Santa match</p><h3>${escapeHtml(matchName)}</h3></article>`;
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

function renderNames(names) {
  nameList.replaceChildren();
  participantSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.disabled = true;
  placeholder.selected = true;
  placeholder.textContent = names.length ? "Select your name" : "No names left to match";
  participantSelect.append(placeholder);
  emptyRoster.hidden = names.length > 0;
  names.forEach((person) => {
    const item = document.createElement("li");
    item.textContent = person.name;
    nameList.append(item);

    const option = document.createElement("option");
    option.value = person.id;
    option.textContent = person.name;
    participantSelect.append(option);
  });
}

async function refreshStatus() {
  try {
    const data = await readJson(await fetch("/api/status"));
    const phase = data.drawn ? "all matches are complete" : `${data.remaining} names left to match`;
    statusLine.textContent = phase;
    renderNames(data.names || []);
    const sessionMatch = data.sessionMatch || {};
    if (sessionMatch.matched) {
      showMatch(sessionMatch.matchName);
    }
    emptyRoster.textContent = data.drawn
      ? "Everyone has been matched."
      : "No names are available to match.";
    matchForm.hidden = data.drawn || Boolean(sessionMatch.matched);
    matchForm.querySelector("button").disabled = data.drawn || Boolean(sessionMatch.matched) || (data.names || []).length === 0;
    matchForm.querySelector("button").textContent = data.drawn ? "All matches complete" : "Match me";
  } catch {
    statusLine.textContent = "Could not load the draw";
  }
}

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
    await refreshStatus();
  } catch (err) {
    showError(err.message);
    button.disabled = false;
  }
});

refreshStatus();
