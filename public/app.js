const statusLine = document.getElementById("statusLine");
const joinForm = document.getElementById("joinForm");
const lookupForm = document.getElementById("lookupForm");
const hostForm = document.getElementById("hostForm");
const result = document.getElementById("result");
const errorBox = document.getElementById("error");

function showError(message) {
  errorBox.hidden = !message;
  errorBox.textContent = message || "";
  if (message) {
    errorBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function showTicket({ status, matchName }) {
  result.hidden = false;
  if (status === "paired") {
    result.innerHTML = `
      <article class="ticket paired">
        <p>You are buying for</p>
        <h3>${escapeHtml(matchName)}</h3>
      </article>
    `;
  } else {
    result.innerHTML = `
      <article class="ticket waiting">
        <p>You're in the hat</p>
        <h3>Matching comes later</h3>
      </article>
    `;
  }
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

async function refreshStatus() {
  try {
    const data = await readJson(await fetch("/api/status"));
    const phase = data.drawn ? "matches are ready" : "collecting names";
    statusLine.textContent = `${data.count} of ${data.max} names · ${phase}`;
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

function formPayload(form) {
  const body = new FormData(form);
  return {
    name: String(body.get("name") || ""),
    pin: String(body.get("pin") || ""),
  };
}

function setTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    const on = tab.dataset.tab === name;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.classList.toggle("is-active", panel.dataset.panel === name);
  });
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => setTab(tab.dataset.tab));
});

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  try {
    const data = await readJson(
      await fetch("/api/join", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formPayload(joinForm)),
      })
    );
    showTicket(data);
    await refreshStatus();
  } catch (err) {
    showError(err.message);
  }
});

lookupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  try {
    const data = await readJson(
      await fetch("/api/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(formPayload(lookupForm)),
      })
    );
    showTicket(data);
  } catch (err) {
    showError(err.message);
  }
});

hostForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  const action = event.submitter && event.submitter.value === "reset" ? "reset" : "draw";
  const secret = String(new FormData(hostForm).get("secret") || "");
  try {
    const data = await readJson(
      await fetch(`/api/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-secret": secret,
        },
        body: JSON.stringify({ secret }),
      })
    );
    result.hidden = false;
    result.innerHTML =
      action === "reset"
        ? `<article class="ticket waiting"><p>Host</p><h3>Draw cleared</h3></article>`
        : `<article class="ticket paired"><p>Host</p><h3>Matched ${data.count} people</h3></article>`;
    result.scrollIntoView({ behavior: "smooth", block: "nearest" });
    await refreshStatus();
  } catch (err) {
    showError(err.message);
  }
});

refreshStatus();
