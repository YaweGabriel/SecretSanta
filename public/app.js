const statusLine = document.getElementById("statusLine");
const joinForm = document.getElementById("joinForm");
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

function showEnrolled(name) {
  result.hidden = false;
  result.innerHTML = `
    <article class="ticket waiting">
      <p>You're in the hat</p>
      <h3>${escapeHtml(name)}</h3>
    </article>
  `;
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
  emptyRoster.hidden = names.length > 0;
  names.forEach((name) => {
    const item = document.createElement("li");
    item.textContent = name;
    nameList.append(item);
  });
}

async function refreshStatus() {
  try {
    const data = await readJson(await fetch("/api/status"));
    const phase = data.drawn ? "matches are ready" : "collecting names";
    statusLine.textContent = `${data.count} of ${data.max} names · ${phase}`;
    renderNames(data.names || []);
    const closed = data.drawn || data.count >= data.max;
    joinForm.querySelector("button").disabled = closed;
    joinForm.querySelector("button").textContent = data.drawn
      ? "Matching already started"
      : data.count >= data.max
        ? "Draw is full"
        : "Put my name in";
  } catch {
    statusLine.textContent = "Could not load the draw";
  }
}

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  const name = String(new FormData(joinForm).get("name") || "").trim();
  try {
    await readJson(
      await fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      })
    );
    joinForm.reset();
    showEnrolled(name);
    await refreshStatus();
  } catch (err) {
    showError(err.message);
  }
});

refreshStatus();
