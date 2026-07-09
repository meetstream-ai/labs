(function () {
  const navItems = document.querySelectorAll(".nav-item");
  const tabs = document.querySelectorAll(".tab");

  navItems.forEach((item) => {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      const target = item.getAttribute("data-tab");
      navItems.forEach((i) => i.classList.remove("active"));
      tabs.forEach((t) => t.classList.remove("active"));
      item.classList.add("active");
      document.getElementById(`tab-${target}`).classList.add("active");
    });
  });

  const apiKeyInput = document.getElementById("api-key");
  const toggleKeyBtn = document.getElementById("toggle-key");
  toggleKeyBtn.addEventListener("click", () => {
    const isPassword = apiKeyInput.type === "password";
    apiKeyInput.type = isPassword ? "text" : "password";
    toggleKeyBtn.textContent = isPassword ? "hide" : "show";
  });

  const deployBtn = document.getElementById("deploy-btn");
  const meetingLinkInput = document.getElementById("meeting-link");
  const deployError = document.getElementById("deploy-error");

  function showDeployError(message) {
    deployError.textContent = message;
    deployError.classList.remove("hidden");
  }

  function clearDeployError() {
    deployError.classList.add("hidden");
    deployError.textContent = "";
  }

  deployBtn.addEventListener("click", async () => {
    clearDeployError();
    const api_key = apiKeyInput.value.trim();
    const meeting_link = meetingLinkInput.value.trim();

    if (!meeting_link) {
      showDeployError("Meeting link is required");
      return;
    }

    deployBtn.disabled = true;
    deployBtn.textContent = "Deploying...";

    try {
      const response = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key, meeting_link })
      });
      const data = await response.json();
      if (!response.ok) {
        showDeployError(data.error || "Failed to deploy agent");
      }
    } catch (err) {
      showDeployError(`Failed to reach dashboard server: ${err}`);
    } finally {
      deployBtn.disabled = false;
      deployBtn.textContent = "Deploy Agent";
      refreshStatus();
    }
  });

  function formatDuration(totalSeconds) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function setStatusPill(el, status) {
    el.className = "status-pill";
    el.classList.add(status);
    el.textContent = status.charAt(0).toUpperCase() + status.slice(1);
  }

  let clearedAt = null;

  function renderLogs(logs) {
    const boxes = [
      document.getElementById("logs-box-inline"),
      document.getElementById("logs-box-full")
    ];
    const visibleLogs = clearedAt ? logs.filter((entry) => entry.time > clearedAt) : logs;
    const html = visibleLogs
      .map((entry) => {
        const time = entry.time.split("T")[1].split(".")[0];
        return `<div class="log-line"><span class="log-time">${time}</span>${escapeHtml(entry.message)}</div>`;
      })
      .join("");
    boxes.forEach((box) => {
      const wasScrolledToBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 10;
      box.innerHTML = html || '<p class="empty">No log entries yet.</p>';
      if (wasScrolledToBottom) {
        box.scrollTop = box.scrollHeight;
      }
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function renderSession(session, status, elapsedSeconds) {
    const rowsHtml = session.bot_id
      ? `<tr>
          <td title="${session.bot_id}">${session.bot_id}</td>
          <td>${session.platform || "Unknown"}</td>
          <td title="${session.meeting_link}">${session.meeting_link}</td>
          <td>${session.start_time ? session.start_time.split("T")[1].split(".")[0] : "—"}</td>
          <td>${formatDuration(elapsedSeconds)}</td>
          <td>${status}</td>
        </tr>`
      : `<tr><td colspan="6" class="empty-row">&mdash;</td></tr>`;

    document.getElementById("session-body-inline").innerHTML = rowsHtml;
    document.getElementById("session-body-full").innerHTML = rowsHtml;
  }

  async function refreshStatus() {
    try {
      const response = await fetch("/api/status");
      const data = await response.json();

      document.getElementById("stat-status").textContent =
        data.status.charAt(0).toUpperCase() + data.status.slice(1);
      document.getElementById("stat-status-sub").textContent =
        data.session.bot_id ? `Bot ${data.session.bot_id.slice(0, 8)}` : "No agent deployed";
      document.getElementById("stat-elapsed").textContent = formatDuration(data.elapsed_seconds);
      document.getElementById("stat-sentences").textContent = data.sentence_count;
      document.getElementById("stat-saved").textContent = data.transcripts_saved;

      setStatusPill(document.getElementById("status-pill"), data.status);
      renderSession(data.session, data.status, data.elapsed_seconds);
      renderLogs(data.logs);
    } catch (err) {
      // Dashboard server may be briefly unreachable between polls; ignore.
    }
  }

  function renderFiles(files) {
    const targets = [
      { el: document.getElementById("files-list-inline"), mode: "list" },
      { el: document.getElementById("files-body-full"), mode: "table" }
    ];

    targets.forEach(({ el, mode }) => {
      if (files.length === 0) {
        el.innerHTML =
          mode === "list"
            ? '<p class="empty">No transcripts yet. Deploy an agent and let it capture some sentences.</p>'
            : '<tr><td colspan="5" class="empty-row">No transcripts saved yet.</td></tr>';
        return;
      }

      if (mode === "list") {
        el.innerHTML = files
          .map(
            (f) =>
              `<div class="file-row"><span>${f.filename} (${f.sentence_count})</span><a href="/transcripts/${f.filename}" download>download</a></div>`
          )
          .join("");
      } else {
        el.innerHTML = files
          .map(
            (f) => `<tr>
              <td>${f.filename}</td>
              <td title="${f.bot_id || ""}">${f.bot_id || "—"}</td>
              <td>${f.sentence_count}</td>
              <td>${f.saved_at || "—"}</td>
              <td><a href="/transcripts/${f.filename}" download>download</a></td>
            </tr>`
          )
          .join("");
      }
    });
  }

  async function refreshFiles() {
    try {
      const response = await fetch("/api/transcripts");
      const data = await response.json();
      renderFiles(data.files || []);
    } catch (err) {
      // ignore transient failures
    }
  }

  document.getElementById("refresh-files-inline").addEventListener("click", refreshFiles);
  document.getElementById("refresh-files-full").addEventListener("click", refreshFiles);

  function clearLogs() {
    clearedAt = new Date().toISOString();
    renderLogs([]);
  }
  document.getElementById("clear-logs-inline").addEventListener("click", clearLogs);
  document.getElementById("clear-logs-full").addEventListener("click", clearLogs);

  refreshStatus();
  refreshFiles();
  setInterval(refreshStatus, 1500);
  setInterval(refreshFiles, 5000);
})();
