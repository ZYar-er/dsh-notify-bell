/* DSH Notify Bell — sound showcase behavior.
 * - Play/pause per sound card with progress + per-card volume.
 * - Demo buttons play the same local WAV files the plugin ships.
 * - Theme toggle: system (default) / light / dark, persisted in localStorage.
 * No autoplay, no CDN, no browser Notification. */

(function () {
	"use strict";

	/* ---------- Data ---------- */
	/** Status text shown next to the demo buttons for each sound. */
	var DEMO_STATUS = {
		done: "Task completed",
		permission: "Approval required",
		question: "Question waiting",
		block: "Goal blocked",
		error: "Agent error"
	};

	/** Human event name for aria-labels. */
	var EVENT_NAMES = {
		done: "Complete",
		permission: "Approval",
		question: "Question",
		block: "Block",
		error: "Error"
	};

	/* ---------- Theme ---------- */
	var THEME_KEY = "dsh-notify-bell-theme";
	var THEMES = ["system", "light", "dark"];

	function applyTheme(theme) {
		document.documentElement.setAttribute("data-theme", theme);
		var label = document.querySelector(".theme-label");
		if (label) label.textContent = "Theme: " + theme;
	}

	function currentTheme() {
		var saved = null;
		try {
			saved = localStorage.getItem(THEME_KEY);
		} catch (e) {
			/* localStorage unavailable: stay with system default */
		}
		return THEMES.indexOf(saved) !== -1 ? saved : "system";
	}

	var themeToggle = document.getElementById("theme-toggle");
	if (themeToggle) {
		applyTheme(currentTheme());
		themeToggle.addEventListener("click", function () {
			var next = THEMES[(THEMES.indexOf(currentTheme()) + 1) % THEMES.length];
			try {
				localStorage.setItem(THEME_KEY, next);
			} catch (e) {
				/* ignore storage failures */
			}
			applyTheme(next);
		});
	}

	/* ---------- Audio per sound ---------- */
	var audios = {};
	var playing = {};

	function audioFor(sound) {
		if (!audios[sound]) {
			var el = document.querySelector('audio[data-audio="' + sound + '"]');
			audios[sound] = el;
			if (el) {
				el.addEventListener("ended", function () { setPlayState(sound, false); });
				el.addEventListener("pause", function () { setPlayState(sound, false); });
			}
		}
		return audios[sound];
	}

	function setPlayState(sound, isPlaying) {
		playing[sound] = isPlaying;
		var btn = document.querySelector('.play-btn[data-play="' + sound + '"]');
		if (!btn) return;
		btn.classList.toggle("playing", isPlaying);
		btn.querySelector(".play-text").textContent = isPlaying ? "Pause" : "Play";
		btn.setAttribute("aria-label", (isPlaying ? "Pause " : "Play ") + EVENT_NAMES[sound] + " sound");
	}

	function playSound(sound) {
		var el = audioFor(sound);
		if (!el) return;
		// One sound at a time: pause whatever is playing before starting.
		Object.keys(playing).forEach(function (key) {
			if (playing[key] && key !== sound) {
				var other = audioFor(key);
				if (other) { other.pause(); other.currentTime = 0; }
			}
		});
		if (el.paused) {
			el.currentTime = 0;
			el.play().catch(function () {
				/* autoplay-blocked or decode failure: reset state */
				setPlayState(sound, false);
			});
			setPlayState(sound, true);
		} else {
			el.pause();
			el.currentTime = 0;
			setPlayState(sound, false);
		}
	}

	/* ---------- Play buttons ---------- */
	document.querySelectorAll(".play-btn").forEach(function (btn) {
		btn.addEventListener("click", function () {
			playSound(btn.getAttribute("data-play"));
		});
	});

	/* ---------- Progress ---------- */
	document.querySelectorAll(".card-audio").forEach(function (el) {
		var sound = el.getAttribute("data-audio");
		var fill = document.querySelector('.card[data-card="' + sound + '"] .progress-fill');
		var time = document.querySelector('.card[data-card="' + sound + '"] .card-time');
		var progress = document.querySelector('.card[data-card="' + sound + '"] .progress');
		el.addEventListener("timeupdate", function () {
			var d = el.duration || 0;
			var pct = d > 0 ? (el.currentTime / d) * 100 : 0;
			if (fill) fill.style.width = pct + "%";
			if (progress) progress.setAttribute("aria-valuenow", String(Math.round(pct)));
			if (time) time.textContent = el.currentTime.toFixed(1) + " / " + d.toFixed(1) + "s";
		});
		el.addEventListener("loadedmetadata", function () {
			var d = el.duration || 0;
			if (time) time.textContent = "0.0 / " + d.toFixed(1) + "s";
		});
	});

	/* ---------- Per-card volume ---------- */
	document.querySelectorAll(".volume").forEach(function (input) {
		input.addEventListener("input", function () {
			var el = audioFor(input.id.replace("vol-", ""));
			if (el) el.volume = Number(input.value) / 100;
		});
	});

	/* ---------- Demo buttons ---------- */
	var statusEl = document.getElementById("demo-status");
	document.querySelectorAll(".demo-btn").forEach(function (btn) {
		btn.addEventListener("click", function () {
			var sound = btn.getAttribute("data-sound");
			playSound(sound);
			if (statusEl) statusEl.textContent = DEMO_STATUS[sound] || "";
		});
	});
})();
