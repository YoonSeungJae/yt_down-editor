/* ============================================================
   Media Editor – editor.js
   Timeline editor, playback, rendering, export
   ============================================================ */
(() => {
  "use strict";

  // ════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ════════════════════════════════════════════════════════════
  const CFG = {
    TRACK_H: 56,
    TRACK_GAP: 2,
    RULER_H: 28,
    HEADER_W: 72,
    HANDLE_W: 7,
    SNAP_PX: 6,
    MIN_CLIP_PX: 16,
    COLORS: ["#3a86ff", "#ef476f", "#06d6a0", "#ffd166", "#8338ec", "#118ab2", "#e76f51", "#457b9d", "#f4a261", "#2a9d8f"],
  };

  // ════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════
  const S = {
    files: {}, // fileId → file info
    clips: [], // Clip[]
    tracks: 1,
    selClipId: -1,
    pps: 50, // pixels per second
    scrollX: 0,
    scrollY: 0,
    playhead: 0,
    playing: false,
    tool: "select",
    canvasW: 0,
    canvasH: 0,
    colorIdx: 0,
  };
  const waveforms = {}; // fileId → Float32Array peaks
  let clipIdSeq = 0;
  let _dirty = true;

  // ════════════════════════════════════════════════════════════
  // UNDO / REDO HISTORY
  // ════════════════════════════════════════════════════════════
  const history = {
    stack: [], // 스냅샷 배열
    idx: -1, // 현재 위치
    MAX: 80, // 최대 히스토리
    _skip: false, // undo/redo 복원 중 재기록 방지
  };

  function _snapshotClips() {
    return S.clips.map((c) => ({
      id: c.id,
      fileId: c.fileId,
      track: c.track,
      offset: c.offset,
      trimStart: c.trimStart,
      trimEnd: c.trimEnd,
      volume: c.volume,
      speed: c.speed,
      color: c.color,
    }));
  }

  function _restoreClips(snap) {
    S.clips = snap.clips.map((d) => {
      const c = Object.create(Clip.prototype);
      Object.assign(c, d);
      return c;
    });
    S.tracks = snap.tracks;
    S.selClipId = snap.selClipId;
    clipIdSeq = snap.clipIdSeq;
    for (const [id] of playback.audios) {
      if (!S.clips.some((c) => c.id === id)) playback.removeClip(id);
    }
    updateProperties();
    requestRender();
  }

  /** 변경 전 호출 – 현재 상태를 스택에 저장 */
  function saveUndo() {
    if (history._skip) return;
    history.stack.length = history.idx + 1;
    history.stack.push({
      clips: _snapshotClips(),
      tracks: S.tracks,
      selClipId: S.selClipId,
      clipIdSeq,
    });
    if (history.stack.length > history.MAX) history.stack.shift();
    history.idx = history.stack.length - 1;
    _updateUndoButtons();
  }

  function undo() {
    if (history.idx <= 0) return;
    if (history.idx === history.stack.length - 1) {
      history.stack.push({
        clips: _snapshotClips(),
        tracks: S.tracks,
        selClipId: S.selClipId,
        clipIdSeq,
      });
    }
    history.idx--;
    history._skip = true;
    _restoreClips(history.stack[history.idx]);
    history._skip = false;
    _updateUndoButtons();
    $tlStatus.textContent = "되돌리기";
  }

  function redo() {
    if (history.idx >= history.stack.length - 1) return;
    history.idx++;
    history._skip = true;
    _restoreClips(history.stack[history.idx]);
    history._skip = false;
    _updateUndoButtons();
    $tlStatus.textContent = "다시 실행";
  }

  function _updateUndoButtons() {
    const btnUndo = document.getElementById("btn-undo");
    const btnRedo = document.getElementById("btn-redo");
    if (btnUndo) btnUndo.disabled = history.idx <= 0;
    if (btnRedo) btnRedo.disabled = history.idx >= history.stack.length - 1;
  }

  // ════════════════════════════════════════════════════════════
  // CLIP CLASS
  // ════════════════════════════════════════════════════════════
  class Clip {
    constructor(fileId, track = 0, offset = 0) {
      this.id = ++clipIdSeq;
      this.fileId = fileId;
      this.track = track;
      this.offset = offset;
      this.trimStart = 0;
      this.trimEnd = S.files[fileId].duration;
      this.volume = 100;
      this.speed = 1.0;
      this.color = CFG.COLORS[S.colorIdx++ % CFG.COLORS.length];
    }
    get clipDuration() {
      return Math.max(0, (this.trimEnd - this.trimStart) / this.speed);
    }
    get file() {
      return S.files[this.fileId];
    }
    clone() {
      const c = Object.create(Clip.prototype);
      Object.assign(c, { ...this, id: ++clipIdSeq });
      return c;
    }
  }

  // ════════════════════════════════════════════════════════════
  // DRAG STATE
  // ════════════════════════════════════════════════════════════
  let drag = { mode: null };
  let trackDrag = { active: false, srcTrack: -1, curTrack: -1 };

  // ════════════════════════════════════════════════════════════
  // DOM REFERENCES
  // ════════════════════════════════════════════════════════════
  let $c, ctx; // canvas & context
  let $video, $placeholder, $fileList, $fileInput, $timecode;
  let $coverImg, $coverInput, $coverRemoveBtn;
  let hasCoverImage = false;
  let $propsContent, $propsEmpty;
  let $pName, $pType, $pDur, $pTrack, $pOffset, $pTrimS, $pTrimE, $pVolume, $pVolumeSlider, $pSpeed;
  let $exportProgress, $exportFill, $exportText, $tlStatus;
  let $scrollbar, $scrollThumb;
  let $vScrollbar, $vScrollThumb;

  // ════════════════════════════════════════════════════════════
  // PLAYBACK ENGINE
  // ════════════════════════════════════════════════════════════
  const playback = {
    audios: new Map(), // clipId → HTMLAudioElement
    refTime: 0,
    startPH: 0,

    ensureAudio(clip) {
      if (this.audios.has(clip.id)) return this.audios.get(clip.id);
      const el = new Audio(`/api/media/${clip.fileId}`);
      el.preload = "auto";
      this.audios.set(clip.id, el);
      return el;
    },
    play() {
      if (S.playing) return;
      S.playing = true;
      this.refTime = performance.now() / 1000;
      this.startPH = S.playhead;
      S.clips.forEach((c) => {
        if (S.files[c.fileId]?.hasAudio) this.ensureAudio(c);
      });
      this._tick();
      _updatePlayBtn();
    },
    pause() {
      S.playing = false;
      this.audios.forEach((el) => el.pause());
      _updatePlayBtn();
    },
    toggle() {
      S.playing ? this.pause() : this.play();
    },
    stop() {
      this.pause();
      S.playhead = 0;
      requestRender();
    },
    seek(t) {
      const was = S.playing;
      if (was) this.pause();
      S.playhead = Math.max(0, t);
      $timecode.textContent = fmtTime(S.playhead);
      updateVideoPreview();
      if (was) this.play();
      requestRender();
    },
    removeClip(id) {
      const el = this.audios.get(id);
      if (el) {
        el.pause();
        el.src = "";
        this.audios.delete(id);
      }
    },
    _tick() {
      if (!S.playing) return;
      const now = performance.now() / 1000;
      S.playhead = this.startPH + (now - this.refTime);
      const total = getTotalDuration();
      if (S.playhead >= total && total > 0) {
        S.playhead = total;
        this.pause();
        requestRender();
        return;
      }
      // Sync audio elements
      for (const clip of S.clips) {
        const el = this.audios.get(clip.id);
        if (!el) continue;
        const cStart = clip.offset,
          cEnd = clip.offset + clip.clipDuration;
        const inRange = S.playhead >= cStart && S.playhead < cEnd;
        if (inRange) {
          const expected = clip.trimStart + (S.playhead - cStart) * clip.speed;
          // 소스 미디어의 trimEnd를 초과하지 않도록 클램핑
          if (expected >= clip.trimEnd) {
            if (!el.paused) el.pause();
            continue;
          }
          el.volume = Math.min(1, clip.volume / 100);
          el.playbackRate = clip.speed;
          if (el.paused) {
            el.currentTime = expected;
            el.play().catch(() => {});
          } else if (Math.abs(el.currentTime - expected) > 0.15) {
            el.currentTime = expected;
          }
          // 소스 재생 위치가 trimEnd를 넘었으면 즉시 정지
          if (el.currentTime >= clip.trimEnd) {
            el.pause();
          }
        } else if (!el.paused) {
          el.pause();
        }
      }
      updateVideoPreview();
      $timecode.textContent = fmtTime(S.playhead);
      requestRender();
      requestAnimationFrame(() => this._tick());
    },
  };

  // ════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ════════════════════════════════════════════════════════════
  function init() {
    try {
      _init();
    } catch (e) {
      console.error("Media Editor init error:", e);
      document.body.innerHTML = '<div style="color:#ff4444;padding:40px;font-size:16px;"><h2>초기화 오류</h2><pre>' + e.message + "\n" + e.stack + "</pre></div>";
    }
  }
  function _init() {
    console.log("[MediaEditor] init start");
    // DOM refs
    $c = document.getElementById("tl-canvas");
    ctx = $c.getContext("2d");
    $video = document.getElementById("preview-video");
    $placeholder = document.getElementById("preview-placeholder");
    $fileList = document.getElementById("file-list");
    $fileInput = document.getElementById("file-input");
    $timecode = document.getElementById("timecode");
    $propsContent = document.getElementById("props-content");
    $propsEmpty = document.getElementById("props-empty");
    $pName = document.getElementById("p-name");
    $pType = document.getElementById("p-type");
    $pDur = document.getElementById("p-dur");
    $pTrack = document.getElementById("p-track");
    $pOffset = document.getElementById("p-offset");
    $pTrimS = document.getElementById("p-trim-s");
    $pTrimE = document.getElementById("p-trim-e");
    $pVolume = document.getElementById("p-volume");
    $pVolumeSlider = document.getElementById("p-volume-slider");
    $pSpeed = document.getElementById("p-speed");
    $exportProgress = document.getElementById("export-progress");
    $exportFill = document.getElementById("export-fill");
    $exportText = document.getElementById("export-text");
    $tlStatus = document.getElementById("tl-status");
    $scrollbar = document.getElementById("tl-scrollbar");
    $scrollThumb = document.getElementById("tl-scroll-thumb");
    $vScrollbar = document.getElementById("tl-vscrollbar");
    $vScrollThumb = document.getElementById("tl-vscroll-thumb");
    $coverImg = document.getElementById("preview-cover");
    $coverInput = document.getElementById("cover-input");
    $coverRemoveBtn = document.getElementById("btn-cover-remove");

    // Cover image events
    $coverInput.addEventListener("change", onCoverSelect);
    $coverRemoveBtn.addEventListener("click", onCoverRemove);
    _checkExistingCover();

    // Canvas events
    $c.addEventListener("mousedown", onMouseDown);
    $c.addEventListener("mousemove", onMouseMove);
    $c.addEventListener("mouseup", onMouseUp);
    $c.addEventListener("mouseleave", onMouseUp);
    $c.addEventListener("wheel", onWheel, { passive: false });
    $c.addEventListener("contextmenu", onContextMenu);
    $c.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    });
    $c.addEventListener("drop", onCanvasDrop);

    // File list drop
    $fileList.addEventListener("dragover", (e) => {
      e.preventDefault();
      $fileList.classList.add("drag-over");
    });
    $fileList.addEventListener("dragleave", () => $fileList.classList.remove("drag-over"));
    $fileList.addEventListener("drop", onFileListDrop);

    // File input
    $fileInput.addEventListener("change", (e) => {
      if (e.target.files.length) uploadFiles(e.target.files);
      e.target.value = "";
    });

    // Toolbar buttons
    document.getElementById("btn-play").addEventListener("click", () => playback.toggle());
    document.getElementById("btn-stop").addEventListener("click", () => playback.stop());
    document.getElementById("btn-prev").addEventListener("click", () => playback.seek(0));
    document.getElementById("btn-export").addEventListener("click", startExport);
    document.getElementById("btn-save-project").addEventListener("click", saveProject);
    document.getElementById("btn-load-project").addEventListener("click", () => document.getElementById("project-file-input").click());
    document.getElementById("project-file-input").addEventListener("change", (e) => {
      if (e.target.files.length) loadProjectFile(e.target.files[0]);
      e.target.value = "";
    });
    document.getElementById("btn-settings").addEventListener("click", openSettings);
    document.getElementById("btn-undo").addEventListener("click", undo);
    document.getElementById("btn-redo").addEventListener("click", redo);
    document.getElementById("btn-add-track").addEventListener("click", addTrack);
    document.getElementById("btn-clean-tracks").addEventListener("click", cleanTracks);
    document.getElementById("btn-zoom-in").addEventListener("click", () => zoomStep(1));
    document.getElementById("btn-zoom-out").addEventListener("click", () => zoomStep(-1));
    document.getElementById("btn-zoom-fit").addEventListener("click", zoomFit);
    document.getElementById("p-apply").addEventListener("click", applyProps);
    $pVolume.addEventListener("input", () => {
      $pVolumeSlider.value = $pVolume.value;
    });
    $pVolumeSlider.addEventListener("input", () => {
      $pVolume.value = $pVolumeSlider.value;
    });
    document.querySelectorAll(".tool-btn").forEach((b) => b.addEventListener("click", () => setTool(b.dataset.tool)));

    // Keys
    document.addEventListener("keydown", onKeyDown);
    // Resizer
    initResizer();
    initPanelResizers();
    initPropsToggle();
    // Scrollbar
    initScrollbar();
    initVScrollbar();
    // Canvas size
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    // Render loop
    _renderLoop();
    // 초기 undo 스냅샷
    saveUndo();
    console.log("[MediaEditor] init complete, canvasW=", S.canvasW, "canvasH=", S.canvasH);
  }

  // ════════════════════════════════════════════════════════════
  // FILE IMPORT
  // ════════════════════════════════════════════════════════════
  async function uploadFiles(fileList) {
    $tlStatus.textContent = "업로드 중…";
    const fd = new FormData();
    for (const f of fileList) fd.append("files", f);
    try {
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      const list = await r.json();
      for (const f of list) {
        S.files[f.id] = f;
        addFileToProject(f);
        if (f.hasAudio) fetchWaveform(f.id);
      }
      $tlStatus.textContent = `${list.length}개 파일 추가됨`;
    } catch (e) {
      $tlStatus.textContent = `업로드 오류: ${e.message}`;
    }
  }

  async function fetchWaveform(fid) {
    if (waveforms[fid]) return;
    try {
      const r = await fetch(`/api/waveform/${fid}`);
      const d = await r.json();
      waveforms[fid] = d.peaks || [];
      requestRender();
    } catch {
      /* ignore */
    }
  }

  function addFileToProject(file) {
    const item = document.createElement("div");
    item.className = "file-item";
    item.dataset.fileId = file.id;
    item.draggable = true;
    const icon = file.hasVideo ? "🎬" : "🎵";
    item.innerHTML = `<span class="file-icon">${icon}</span>` + `<span class="file-name">${esc(file.name)}</span>` + `<span class="file-dur">${fmtTime(file.duration)}</span>` + `<button class="file-del" title="삭제">✕</button>`;
    item.addEventListener("dblclick", () => addClipToTimeline(file.id));
    item.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-fileid", file.id);
      e.dataTransfer.effectAllowed = "copy";
    });
    item.querySelector(".file-del").addEventListener("click", (e) => {
      e.stopPropagation();
      removeFileFromProject(file.id);
    });
    $fileList.appendChild(item);
    document.getElementById("file-count").textContent = `${Object.keys(S.files).length}개 파일`;
  }

  function removeFileFromProject(fid) {
    // 타임라인에서 해당 파일의 클립 모두 제거
    const toRemove = S.clips.filter((c) => c.fileId === fid).map((c) => c.id);
    toRemove.forEach((id) => removeClip(id));
    // 파일 목록에서 제거
    delete S.files[fid];
    delete waveforms[fid];
    const el = $fileList.querySelector(`[data-file-id="${fid}"]`);
    if (el) el.remove();
    document.getElementById("file-count").textContent = `${Object.keys(S.files).length}개 파일`;
    requestRender();
  }

  function onFileListDrop(e) {
    e.preventDefault();
    $fileList.classList.remove("drag-over");
    if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
  }

  function onCanvasDrop(e) {
    e.preventDefault();
    const fid = e.dataTransfer.getData("application/x-fileid");
    if (!fid || !S.files[fid]) return;
    const rect = $c.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const t = Math.max(0, x2time(mx));
    const tr = Math.max(0, y2track(my));
    addClipToTimeline(fid, tr, t);
  }

  // ════════════════════════════════════════════════════════════
  // CLIPS & TRACKS
  // ════════════════════════════════════════════════════════════
  function addClipToTimeline(fileId, track = -1, offset = -1) {
    if (track < 0) {
      // 빈 트랙 찾기, 없으면 마지막 트랙 뒤에 추가
      let found = -1;
      for (let t = 0; t < S.tracks; t++) {
        if (!S.clips.some((c) => c.track === t)) {
          found = t;
          break;
        }
      }
      track = found >= 0 ? found : S.tracks;
    }
    S.tracks = Math.max(S.tracks, track + 1);
    const clip = new Clip(fileId, track, 0);
    if (offset >= 0) {
      clip.offset = snapTime(offset, clip);
    } else {
      const onTr = S.clips.filter((c) => c.track === clip.track);
      clip.offset = onTr.reduce((m, c) => Math.max(m, c.offset + c.clipDuration), 0);
    }
    saveUndo();
    S.clips.push(clip);
    S.selClipId = clip.id;
    requestRender();
    updateProperties();
    $tlStatus.textContent = `추가: ${S.files[fileId].name} → T${clip.track + 1}`;
  }

  function removeClip(id) {
    saveUndo();
    S.clips = S.clips.filter((c) => c.id !== id);
    playback.removeClip(id);
    if (S.selClipId === id) {
      S.selClipId = -1;
      updateProperties();
    }
    requestRender();
  }

  function splitAtPlayhead(clip) {
    const t = S.playhead;
    if (t <= clip.offset || t >= clip.offset + clip.clipDuration) return;
    saveUndo();
    const splitPt = clip.trimStart + (t - clip.offset) * clip.speed;
    const nc = clip.clone();
    nc.trimStart = splitPt;
    nc.offset = t;
    clip.trimEnd = splitPt;
    S.clips.push(nc);
    playback.removeClip(clip.id);
    requestRender();
  }

  function duplicateClip(clip) {
    saveUndo();
    const nc = clip.clone();
    nc.offset = clip.offset + clip.clipDuration;
    S.clips.push(nc);
    requestRender();
  }

  function resetTrim(clip) {
    saveUndo();
    clip.trimStart = 0;
    clip.trimEnd = S.files[clip.fileId].duration;
    requestRender();
    updateProperties();
  }

  function resetSpeed(clip) {
    saveUndo();
    clip.speed = 1.0;
    requestRender();
    updateProperties();
  }

  function addTrack() {
    S.tracks++;
    requestRender();
  }

  function cleanTracks() {
    const used = new Set(S.clips.map((c) => c.track));
    if (used.size === 0) {
      S.tracks = 1;
      requestRender();
      return;
    }
    const sortedUsed = [...used].sort((a, b) => a - b);
    const remap = {};
    sortedUsed.forEach((t, i) => {
      remap[t] = i;
    });
    S.clips.forEach((c) => {
      c.track = remap[c.track];
    });
    S.tracks = Math.max(1, sortedUsed.length);
    requestRender();
  }

  // ════════════════════════════════════════════════════════════
  // COORDINATE HELPERS
  // ════════════════════════════════════════════════════════════
  function time2x(t) {
    return CFG.HEADER_W + t * S.pps - S.scrollX;
  }
  function x2time(x) {
    return (x - CFG.HEADER_W + S.scrollX) / S.pps;
  }
  function trackY(tr) {
    return CFG.RULER_H + tr * (CFG.TRACK_H + CFG.TRACK_GAP) - S.scrollY;
  }
  function y2track(y) {
    return Math.floor((y + S.scrollY - CFG.RULER_H) / (CFG.TRACK_H + CFG.TRACK_GAP));
  }
  function getTotalDuration() {
    if (!S.clips.length) return 10;
    return Math.max(...S.clips.map((c) => c.offset + c.clipDuration));
  }

  // ════════════════════════════════════════════════════════════
  // SNAP
  // ════════════════════════════════════════════════════════════
  function snapTime(t, skipClip = null) {
    const threshold = CFG.SNAP_PX / S.pps;
    let best = t,
      bestDist = threshold;
    // snap to playhead
    const dp = Math.abs(t - S.playhead);
    if (dp < bestDist) {
      bestDist = dp;
      best = S.playhead;
    }
    // snap to 0
    if (t < threshold) {
      return 0;
    }
    // snap to clip edges
    for (const c of S.clips) {
      if (skipClip && c.id === skipClip.id) continue;
      for (const edge of [c.offset, c.offset + c.clipDuration]) {
        const d = Math.abs(t - edge);
        if (d < bestDist) {
          bestDist = d;
          best = edge;
        }
      }
    }
    return best;
  }

  // ════════════════════════════════════════════════════════════
  // RENDERING
  // ════════════════════════════════════════════════════════════
  function requestRender() {
    _dirty = true;
  }

  function _renderLoop() {
    if (_dirty) {
      _dirty = false;
      render();
    }
    requestAnimationFrame(_renderLoop);
  }

  function resizeCanvas() {
    const body = document.getElementById("tl-body");
    const rect = body.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    S.canvasW = rect.width;
    S.canvasH = rect.height;
    $c.width = rect.width * dpr;
    $c.height = rect.height * dpr;
    $c.style.width = rect.width + "px";
    $c.style.height = rect.height + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    requestRender();
  }

  function render() {
    const W = S.canvasW,
      H = S.canvasH;
    if (W <= 0 || H <= 0) return;

    ctx.clearRect(0, 0, W, H);

    // --- Background ---
    ctx.fillStyle = "#1e1e1e";
    ctx.fillRect(0, 0, W, H);

    // --- Track backgrounds ---
    ctx.save();
    ctx.beginPath();
    ctx.rect(CFG.HEADER_W, CFG.RULER_H, W - CFG.HEADER_W, H - CFG.RULER_H);
    ctx.clip();
    for (let i = 0; i < S.tracks; i++) {
      const y = trackY(i);
      if (trackDrag.active && i === trackDrag.srcTrack) {
        ctx.fillStyle = "rgba(45, 140, 255, 0.1)";
      } else if (trackDrag.active && i === trackDrag.curTrack && trackDrag.srcTrack !== trackDrag.curTrack) {
        ctx.fillStyle = "rgba(45, 140, 255, 0.15)";
      } else {
        ctx.fillStyle = i % 2 === 0 ? "#252525" : "#2a2a2a";
      }
      ctx.fillRect(CFG.HEADER_W, y, W - CFG.HEADER_W, CFG.TRACK_H);
    }

    // --- Clips ---
    for (const clip of S.clips) drawClip(clip);
    ctx.restore();

    // --- Ruler ---
    drawRuler(W);

    // --- Track Headers ---
    drawTrackHeaders(H);

    // --- Playhead ---
    drawPlayhead(H);

    // --- Scrollbar ---
    updateScrollbar();
    updateVScrollbar();

    // --- Timecode ---
    if (!S.playing) $timecode.textContent = fmtTime(S.playhead);
  }

  function drawRuler(W) {
    ctx.fillStyle = "#2c2c2c";
    ctx.fillRect(0, 0, W, CFG.RULER_H);
    ctx.strokeStyle = "#444";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, CFG.RULER_H - 0.5);
    ctx.lineTo(W, CFG.RULER_H - 0.5);
    ctx.stroke();

    // Time marks
    const stepSec = calcRulerStep();
    const startT = Math.floor(x2time(CFG.HEADER_W) / stepSec) * stepSec;
    const endT = x2time(W) + stepSec;

    ctx.fillStyle = "#999";
    ctx.font = "10px Consolas, monospace";
    ctx.textBaseline = "top";

    for (let t = startT; t <= endT; t += stepSec) {
      if (t < 0) continue;
      const x = time2x(t);
      if (x < CFG.HEADER_W || x > W) continue;
      // Major tick
      ctx.strokeStyle = "#555";
      ctx.beginPath();
      ctx.moveTo(x + 0.5, CFG.RULER_H - 12);
      ctx.lineTo(x + 0.5, CFG.RULER_H);
      ctx.stroke();
      ctx.fillText(fmtTimeShort(t), x + 3, 4);
      // Minor ticks
      const minor = stepSec / 4;
      for (let j = 1; j < 4; j++) {
        const mx = time2x(t + j * minor);
        if (mx < CFG.HEADER_W || mx > W) continue;
        ctx.strokeStyle = "#3a3a3a";
        ctx.beginPath();
        ctx.moveTo(mx + 0.5, CFG.RULER_H - 5);
        ctx.lineTo(mx + 0.5, CFG.RULER_H);
        ctx.stroke();
      }
    }
  }

  function calcRulerStep() {
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const ideal = 80 / S.pps; // ~80px between major marks
    for (const s of steps) {
      if (s >= ideal) return s;
    }
    return steps[steps.length - 1];
  }

  function drawTrackHeaders(H) {
    ctx.fillStyle = "#2c2c2c";
    ctx.fillRect(0, 0, CFG.HEADER_W, H);
    ctx.strokeStyle = "#444";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(CFG.HEADER_W - 0.5, 0);
    ctx.lineTo(CFG.HEADER_W - 0.5, H);
    ctx.stroke();

    ctx.font = "11px Segoe UI, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    for (let i = 0; i < S.tracks; i++) {
      const y = trackY(i);
      if (y + CFG.TRACK_H < CFG.RULER_H || y > H) continue;

      // 드래그 중인 소스 트랙 하이라이트
      if (trackDrag.active && i === trackDrag.srcTrack) {
        ctx.fillStyle = "rgba(45, 140, 255, 0.15)";
        ctx.fillRect(0, y, CFG.HEADER_W, CFG.TRACK_H);
      }
      // 드래그 대상 위치 표시
      if (trackDrag.active && i === trackDrag.curTrack && trackDrag.srcTrack !== trackDrag.curTrack) {
        ctx.fillStyle = "rgba(45, 140, 255, 0.25)";
        ctx.fillRect(0, y, CFG.HEADER_W, CFG.TRACK_H);
        // 삽입 라인도 표시 (전체 너비)
        ctx.strokeStyle = "#2d8cff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        const lineY = trackDrag.srcTrack < trackDrag.curTrack ? y + CFG.TRACK_H : y;
        ctx.moveTo(0, lineY);
        ctx.lineTo(S.canvasW, lineY);
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      ctx.fillStyle = trackDrag.active && i === trackDrag.srcTrack ? "#2d8cff" : "#888";
      ctx.fillText(`T${i + 1}`, CFG.HEADER_W / 2, y + CFG.TRACK_H / 2);
      // Separator
      ctx.strokeStyle = "#3a3a3a";
      ctx.beginPath();
      ctx.moveTo(0, y + CFG.TRACK_H + 0.5);
      ctx.lineTo(CFG.HEADER_W, y + CFG.TRACK_H + 0.5);
      ctx.stroke();
    }
    ctx.textAlign = "left";

    // 드래그 중 커서 힌트
    if (trackDrag.active) {
      ctx.fillStyle = "rgba(45, 140, 255, 0.7)";
      ctx.font = "bold 10px Segoe UI, sans-serif";
      ctx.textAlign = "center";
      const dstY = trackY(trackDrag.curTrack);
      ctx.fillText(`← T${trackDrag.srcTrack + 1}`, CFG.HEADER_W / 2, dstY + CFG.TRACK_H + 12);
      ctx.textAlign = "left";
    }

    // Corner
    ctx.fillStyle = "#2c2c2c";
    ctx.fillRect(0, 0, CFG.HEADER_W, CFG.RULER_H);
  }

  function drawClip(clip) {
    const file = S.files[clip.fileId];
    if (!file) return;
    const x = time2x(clip.offset);
    const w = clip.clipDuration * S.pps;
    const y = trackY(clip.track);
    const h = CFG.TRACK_H;

    if (x + w < CFG.HEADER_W || x > S.canvasW) return; // off-screen
    if (w < 1) return;

    const sel = clip.id === S.selClipId;
    const r = 4;

    // Clip body
    ctx.fillStyle = clip.color + (sel ? "dd" : "99");
    roundRect(ctx, x, y + 1, w, h - 2, r);
    ctx.fill();

    // Waveform
    const peaks = waveforms[clip.fileId];
    if (peaks && peaks.length > 0) {
      drawWaveform(peaks, x, y + 16, w, h - 20, clip, file);
    }

    // Label
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 4, y, w - 8, h);
    ctx.clip();
    ctx.fillStyle = "#fff";
    ctx.font = "10px Segoe UI, sans-serif";
    ctx.textBaseline = "top";
    ctx.fillText(file.name, x + 6, y + 4);
    if (clip.volume !== 100) {
      ctx.fillStyle = clip.volume === 0 ? "#ff6666" : "#aaa";
      ctx.font = "9px Consolas, monospace";
      ctx.fillText(`🔊${clip.volume}%`, x + 6, y + 15);
    }
    if (Math.abs(clip.speed - 1.0) > 0.005) {
      ctx.fillStyle = "#88ccff";
      ctx.font = "9px Consolas, monospace";
      const speedY = clip.volume !== 100 ? y + 24 : y + 15;
      ctx.fillText(`⏩${clip.speed.toFixed(2)}x`, x + 6, speedY);
    }
    ctx.restore();

    // Selection border
    if (sel) {
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      roundRect(ctx, x, y + 1, w, h - 2, r);
      ctx.stroke();
    }

    // Trim handles
    if (sel || w > 40) {
      ctx.fillStyle = sel ? "#ffffffaa" : "#ffffff44";
      // Left handle
      roundRect(ctx, x, y + 1, CFG.HANDLE_W, h - 2, [r, 0, 0, r]);
      ctx.fill();
      // Right handle
      roundRect(ctx, x + w - CFG.HANDLE_W, y + 1, CFG.HANDLE_W, h - 2, [0, r, r, 0]);
      ctx.fill();
    }

    // Video icon
    if (file.hasVideo) {
      ctx.fillStyle = "#fff8";
      ctx.font = "10px sans-serif";
      ctx.textBaseline = "bottom";
      ctx.fillText("🎬", x + 6, y + h - 4);
    }
  }

  function drawWaveform(peaks, x, y, w, h, clip, file) {
    if (!peaks.length || w < 4) return;
    const dur = file.duration;
    const startFrac = clip.trimStart / dur;
    const endFrac = clip.trimEnd / dur;
    const si = Math.floor(startFrac * peaks.length);
    const ei = Math.ceil(endFrac * peaks.length);
    const vis = peaks.slice(si, Math.min(ei, peaks.length));
    if (!vis.length) return;

    const midY = y + h / 2;
    const barW = w / vis.length;

    ctx.fillStyle = "rgba(255,255,255,0.55)";
    for (let i = 0; i < vis.length; i++) {
      const bx = x + i * barW;
      const amp = vis[i] * h * 0.45;
      ctx.fillRect(bx, midY - amp, Math.max(1, barW - 0.5), amp * 2);
    }
  }

  function drawPlayhead(H) {
    const x = time2x(S.playhead);
    if (x < CFG.HEADER_W || x > S.canvasW) return;

    ctx.strokeStyle = "#ff4444";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
    ctx.stroke();

    // Triangle head
    ctx.fillStyle = "#ff4444";
    ctx.beginPath();
    ctx.moveTo(x - 6, 0);
    ctx.lineTo(x + 6, 0);
    ctx.lineTo(x, 8);
    ctx.closePath();
    ctx.fill();
  }

  function roundRect(c, x, y, w, h, radii) {
    if (typeof radii === "number") radii = [radii, radii, radii, radii];
    if (radii.length === 2) radii = [radii[0], radii[1], radii[0], radii[1]];
    const [tl, tr, br, bl] = radii;
    c.beginPath();
    c.moveTo(x + tl, y);
    c.lineTo(x + w - tr, y);
    c.arcTo(x + w, y, x + w, y + tr, tr);
    c.lineTo(x + w, y + h - br);
    c.arcTo(x + w, y + h, x + w - br, y + h, br);
    c.lineTo(x + bl, y + h);
    c.arcTo(x, y + h, x, y + h - bl, bl);
    c.lineTo(x, y + tl);
    c.arcTo(x, y, x + tl, y, tl);
    c.closePath();
  }

  // ════════════════════════════════════════════════════════════
  // MOUSE INTERACTION
  // ════════════════════════════════════════════════════════════
  function hitTest(mx, my) {
    for (let i = S.clips.length - 1; i >= 0; i--) {
      const c = S.clips[i];
      const x = time2x(c.offset);
      const w = c.clipDuration * S.pps;
      const y = trackY(c.track);
      if (mx >= x && mx <= x + w && my >= y && my <= y + CFG.TRACK_H) {
        if (mx <= x + CFG.HANDLE_W) return { clip: c, mode: "trim_l" };
        if (mx >= x + w - CFG.HANDLE_W) return { clip: c, mode: "trim_r" };
        return { clip: c, mode: "body" };
      }
    }
    return null;
  }

  function onMouseDown(e) {
    if (e.button === 2) return; // right-click handled by context menu
    const rect = $c.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Click on ruler → playhead
    if (my < CFG.RULER_H) {
      const t = Math.max(0, x2time(mx));
      S.playhead = t;
      drag = { mode: "playhead" };
      if (S.playing) {
        playback.pause();
        playback.play();
      }
      requestRender();
      $timecode.textContent = fmtTime(S.playhead);
      return;
    }

    // Click on track header → start track drag
    if (mx < CFG.HEADER_W && my >= CFG.RULER_H) {
      const tr = y2track(my);
      if (tr >= 0 && tr < S.tracks) {
        trackDrag = { active: true, srcTrack: tr, curTrack: tr };
        $c.style.cursor = "ns-resize";
        requestRender();
        return;
      }
    }

    // Hit test clips
    const hit = hitTest(mx, my);

    if (S.tool === "razor" && hit) {
      splitAtPlayheadTime(hit.clip, x2time(mx));
      return;
    }

    if (hit) {
      S.selClipId = hit.clip.id;
      updateProperties();
      saveUndo(); // 드래그 시작 전 상태 저장

      if (hit.mode === "body") {
        drag = {
          mode: "move",
          clip: hit.clip,
          startX: mx,
          startY: my,
          origOffset: hit.clip.offset,
          origTrack: hit.clip.track,
        };
        $c.style.cursor = "grabbing";
      } else if (hit.mode === "trim_l") {
        if (e.altKey) {
          drag = {
            mode: "stretch_l",
            clip: hit.clip,
            startX: mx,
            origSpeed: hit.clip.speed,
            origOffset: hit.clip.offset,
            sourceDur: hit.clip.trimEnd - hit.clip.trimStart,
            rightEdge: hit.clip.offset + hit.clip.clipDuration,
            origVisualW: hit.clip.clipDuration * S.pps,
          };
        } else {
          drag = {
            mode: "trim_l",
            clip: hit.clip,
            startX: mx,
            origTrimS: hit.clip.trimStart,
            origOffset: hit.clip.offset,
          };
        }
        $c.style.cursor = "w-resize";
      } else if (hit.mode === "trim_r") {
        if (e.altKey) {
          drag = {
            mode: "stretch_r",
            clip: hit.clip,
            startX: mx,
            origSpeed: hit.clip.speed,
            sourceDur: hit.clip.trimEnd - hit.clip.trimStart,
            origVisualW: hit.clip.clipDuration * S.pps,
          };
        } else {
          drag = {
            mode: "trim_r",
            clip: hit.clip,
            startX: mx,
            origTrimE: hit.clip.trimEnd,
          };
        }
        $c.style.cursor = "e-resize";
      }
    } else {
      S.selClipId = -1;
      // Set playhead
      if (mx > CFG.HEADER_W) {
        S.playhead = Math.max(0, x2time(mx));
        drag = { mode: "playhead" };
        $timecode.textContent = fmtTime(S.playhead);
      }
      updateProperties();
    }
    requestRender();
  }

  function onMouseMove(e) {
    const rect = $c.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    // Track header dragging
    if (trackDrag.active) {
      const tr = Math.max(0, Math.min(S.tracks - 1, y2track(my)));
      if (tr !== trackDrag.curTrack) {
        trackDrag.curTrack = tr;
        requestRender();
      }
      return;
    }

    if (!drag.mode) {
      // Cursor style
      if (my < CFG.RULER_H || S.tool === "razor") {
        $c.style.cursor = S.tool === "razor" ? "crosshair" : "pointer";
      } else if (mx < CFG.HEADER_W && my >= CFG.RULER_H) {
        const tr = y2track(my);
        $c.style.cursor = tr >= 0 && tr < S.tracks ? "grab" : "default";
      } else {
        const hit = hitTest(mx, my);
        if (!hit) $c.style.cursor = "default";
        else if (hit.mode === "trim_l") $c.style.cursor = "w-resize";
        else if (hit.mode === "trim_r") $c.style.cursor = "e-resize";
        else $c.style.cursor = "grab";
      }
      return;
    }

    if (drag.mode === "playhead") {
      S.playhead = Math.max(0, x2time(mx));
      $timecode.textContent = fmtTime(S.playhead);
      if (S.playing) {
        playback.pause();
        playback.play();
      }
      updateVideoPreview();
      requestRender();
      return;
    }

    if (drag.mode === "move") {
      const dx = mx - drag.startX;
      const dy = my - drag.startY;
      const newOffset = drag.origOffset + dx / S.pps;
      drag.clip.offset = Math.max(0, snapTime(newOffset, drag.clip));
      const newTrack = Math.max(0, drag.origTrack + Math.round(dy / (CFG.TRACK_H + CFG.TRACK_GAP)));
      drag.clip.track = newTrack;
      S.tracks = Math.max(S.tracks, newTrack + 1);
      requestRender();
      return;
    }

    if (drag.mode === "trim_l") {
      const dx = mx - drag.startX;
      const dt = dx / S.pps;
      const newTS = Math.max(0, drag.origTrimS + dt);
      const maxTS = drag.clip.trimEnd - 0.05;
      drag.clip.trimStart = Math.min(newTS, maxTS);
      drag.clip.offset = drag.origOffset + (drag.clip.trimStart - drag.origTrimS);
      requestRender();
      return;
    }

    if (drag.mode === "trim_r") {
      const dx = mx - drag.startX;
      const dt = dx / S.pps;
      const newTE = drag.origTrimE + dt;
      const maxTE = S.files[drag.clip.fileId].duration;
      drag.clip.trimEnd = Math.max(drag.clip.trimStart + 0.05, Math.min(newTE, maxTE));
      requestRender();
      return;
    }

    if (drag.mode === "stretch_r") {
      const dx = mx - drag.startX;
      const newVisualW = Math.max(CFG.MIN_CLIP_PX, drag.origVisualW + dx);
      const newVisualDur = newVisualW / S.pps;
      drag.clip.speed = Math.max(0.1, Math.min(10, drag.sourceDur / newVisualDur));
      requestRender();
      return;
    }

    if (drag.mode === "stretch_l") {
      const dx = mx - drag.startX;
      const newVisualW = Math.max(CFG.MIN_CLIP_PX, drag.origVisualW - dx);
      const newVisualDur = newVisualW / S.pps;
      drag.clip.speed = Math.max(0.1, Math.min(10, drag.sourceDur / newVisualDur));
      drag.clip.offset = drag.rightEdge - newVisualDur;
      requestRender();
      return;
    }
  }

  function onMouseUp() {
    // Track reorder on drop
    if (trackDrag.active) {
      const src = trackDrag.srcTrack;
      const dst = trackDrag.curTrack;
      if (src !== dst) {
        reorderTrack(src, dst);
      }
      trackDrag = { active: false, srcTrack: -1, curTrack: -1 };
      $c.style.cursor = "";
      requestRender();
      return;
    }

    if (drag.mode === "move" || drag.mode === "trim_l" || drag.mode === "trim_r" || drag.mode === "stretch_l" || drag.mode === "stretch_r") {
      updateProperties();
    }
    drag = { mode: null };
    $c.style.cursor = "";
  }

  function reorderTrack(srcTrack, dstTrack) {
    if (srcTrack === dstTrack) return;
    saveUndo();
    // 트랙을 srcTrack에서 dstTrack 위치로 이동 (insert 방식)
    // 모든 클립의 track 번호를 재배치
    const dir = srcTrack < dstTrack ? 1 : -1;
    for (const clip of S.clips) {
      if (clip.track === srcTrack) {
        clip.track = -999; // 임시 마킹
      } else if (dir === 1 && clip.track > srcTrack && clip.track <= dstTrack) {
        clip.track -= 1;
      } else if (dir === -1 && clip.track >= dstTrack && clip.track < srcTrack) {
        clip.track += 1;
      }
    }
    for (const clip of S.clips) {
      if (clip.track === -999) clip.track = dstTrack;
    }
    $tlStatus.textContent = `T${srcTrack + 1} → T${dstTrack + 1} 이동 완료`;
    updateProperties();
  }

  function splitAtPlayheadTime(clip, t) {
    if (t <= clip.offset || t >= clip.offset + clip.clipDuration) return;
    saveUndo();
    const splitPt = clip.trimStart + (t - clip.offset) * clip.speed;
    const nc = clip.clone();
    nc.trimStart = splitPt;
    nc.offset = t;
    clip.trimEnd = splitPt;
    S.clips.push(nc);
    playback.removeClip(clip.id);
    requestRender();
  }

  // ════════════════════════════════════════════════════════════
  // SCROLL / ZOOM
  // ════════════════════════════════════════════════════════════
  function onWheel(e) {
    e.preventDefault();
    if (e.ctrlKey) {
      // Zoom
      const rect = $c.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const tBefore = x2time(mx);
      const factor = e.deltaY > 0 ? 0.85 : 1.18;
      S.pps = Math.max(5, Math.min(1000, S.pps * factor));
      // Keep mouse position at same time
      S.scrollX = tBefore * S.pps - (mx - CFG.HEADER_W);
      S.scrollX = Math.max(0, S.scrollX);
      document.getElementById("zoom-label").textContent = `${Math.round(S.pps)}px/s`;
      requestRender();
    } else if (e.shiftKey) {
      // Vertical scroll
      const totalTrackH = S.tracks * (CFG.TRACK_H + CFG.TRACK_GAP);
      const visH = S.canvasH - CFG.RULER_H;
      S.scrollY = Math.max(0, Math.min(Math.max(0, totalTrackH - visH), S.scrollY + e.deltaY * 0.5));
      requestRender();
    } else {
      // Horizontal scroll
      S.scrollX += e.deltaY * 0.8;
      S.scrollX = Math.max(0, S.scrollX);
      requestRender();
    }
  }

  function zoomStep(dir) {
    const factor = dir > 0 ? 1.3 : 0.77;
    S.pps = Math.max(5, Math.min(1000, S.pps * factor));
    document.getElementById("zoom-label").textContent = `${Math.round(S.pps)}px/s`;
    requestRender();
  }

  function zoomFit() {
    const total = getTotalDuration();
    if (total <= 0) return;
    const availW = S.canvasW - CFG.HEADER_W - 40;
    S.pps = Math.max(5, availW / total);
    S.scrollX = 0;
    document.getElementById("zoom-label").textContent = `${Math.round(S.pps)}px/s`;
    requestRender();
  }

  // ════════════════════════════════════════════════════════════
  // CONTEXT MENU
  // ════════════════════════════════════════════════════════════
  function onContextMenu(e) {
    e.preventDefault();
    const rect = $c.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const hit = hitTest(mx, my);

    if (hit) {
      S.selClipId = hit.clip.id;
      updateProperties();
      requestRender();
      const clickTime = x2time(mx);
      showContextMenu(e.clientX, e.clientY, [{ label: "✂️  여기서 분할", action: () => splitAtPlayheadTime(hit.clip, clickTime) }, { label: "✂️  재생헤드에서 분할", action: () => splitAtPlayhead(hit.clip) }, { label: "📋  복제", action: () => duplicateClip(hit.clip) }, { sep: true }, { label: "🔄  트림 초기화", action: () => resetTrim(hit.clip) }, { label: "⏱  배속 초기화", action: () => resetSpeed(hit.clip) }, { sep: true }, { label: "❌  삭제", action: () => removeClip(hit.clip.id) }]);
    } else {
      showContextMenu(e.clientX, e.clientY, [
        { label: "➕  트랙 추가", action: addTrack },
        { label: "🧹  빈 트랙 정리", action: cleanTracks },
      ]);
    }
  }

  function showContextMenu(x, y, items) {
    document.getElementById("ctx-menu")?.remove();
    const menu = document.createElement("div");
    menu.id = "ctx-menu";
    menu.className = "context-menu";
    menu.style.left = x + "px";
    menu.style.top = y + "px";
    for (const it of items) {
      if (it.sep) {
        const d = document.createElement("div");
        d.className = "ctx-sep";
        menu.appendChild(d);
      } else {
        const d = document.createElement("div");
        d.className = "ctx-item";
        d.textContent = it.label;
        d.addEventListener("click", () => {
          menu.remove();
          it.action();
        });
        menu.appendChild(d);
      }
    }
    document.body.appendChild(menu);
    // Keep menu within viewport
    const mr = menu.getBoundingClientRect();
    if (mr.right > window.innerWidth) menu.style.left = window.innerWidth - mr.width - 4 + "px";
    if (mr.bottom > window.innerHeight) menu.style.top = window.innerHeight - mr.height - 4 + "px";

    const rm = (ev) => {
      if (!menu.contains(ev.target)) {
        menu.remove();
        document.removeEventListener("mousedown", rm);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", rm), 0);
  }

  // ════════════════════════════════════════════════════════════
  // PROPERTIES PANEL
  // ════════════════════════════════════════════════════════════
  function updateProperties() {
    const clip = S.clips.find((c) => c.id === S.selClipId);
    if (!clip) {
      $propsContent.style.display = "none";
      $propsEmpty.style.display = "";
      return;
    }
    const file = S.files[clip.fileId];
    $propsContent.style.display = "";
    $propsEmpty.style.display = "none";
    $pName.textContent = file.name;
    $pType.textContent = file.hasVideo ? "비디오 (MP4)" : "오디오 (MP3)";
    $pDur.textContent = fmtTime(clip.clipDuration);
    $pTrack.textContent = `T${clip.track + 1}`;
    $pOffset.value = clip.offset.toFixed(2);
    $pTrimS.value = clip.trimStart.toFixed(2);
    $pTrimE.value = clip.trimEnd.toFixed(2);
    $pVolume.value = clip.volume;
    $pVolumeSlider.value = clip.volume;
    if ($pSpeed) $pSpeed.value = clip.speed.toFixed(2);
  }

  function applyProps() {
    const clip = S.clips.find((c) => c.id === S.selClipId);
    if (!clip) return;
    saveUndo();
    const file = S.files[clip.fileId];
    clip.offset = Math.max(0, parseFloat($pOffset.value) || 0);
    clip.trimStart = Math.max(0, Math.min(parseFloat($pTrimS.value) || 0, file.duration));
    clip.trimEnd = Math.max(clip.trimStart + 0.01, Math.min(parseFloat($pTrimE.value) || file.duration, file.duration));
    clip.volume = Math.max(
      0,
      Math.min(
        300,
        (() => {
          const v = parseInt($pVolume.value);
          return isNaN(v) ? 100 : v;
        })(),
      ),
    );
    if ($pSpeed) clip.speed = Math.max(0.1, Math.min(10, parseFloat($pSpeed.value) || 1.0));
    // Apply volume and speed to playback audio immediately
    const aud = playback.audios.get(clip.id);
    if (aud) {
      aud.volume = Math.min(1, clip.volume / 100);
      aud.playbackRate = clip.speed;
    }
    $pDur.textContent = fmtTime(clip.clipDuration);
    requestRender();
  }

  // ════════════════════════════════════════════════════════════
  // VIDEO PREVIEW
  // ════════════════════════════════════════════════════════════
  function updateVideoPreview() {
    let active = null;
    const candidates = S.clips.filter((c) => S.files[c.fileId]?.hasVideo && S.playhead >= c.offset && S.playhead < c.offset + c.clipDuration).sort((a, b) => a.track - b.track);
    active = candidates.length > 0 ? candidates[0] : null;
    if (active) {
      const src = `/api/media/${active.fileId}`;
      if (!$video.src || !$video.src.endsWith(src)) {
        $video.src = src;
      }
      const t = active.trimStart + (S.playhead - active.offset) * active.speed;
      if (Math.abs($video.currentTime - t) > 0.016) {
        $video.currentTime = t;
      }
      $video.style.display = "block";
      $coverImg.style.display = "none";
      $placeholder.style.display = "none";
    } else if (hasCoverImage) {
      // 비디오 클립 없으면 커버 이미지 표시
      if ($video.style.display !== "none") {
        $video.pause();
        $video.removeAttribute("src");
        $video.load();
        $video.style.display = "none";
      }
      $coverImg.style.display = "block";
      $placeholder.style.display = "none";
    } else {
      // 클립 범위 밖이면 검은 화면 표시
      if ($video.style.display !== "none") {
        $video.pause();
        $video.removeAttribute("src");
        $video.load();
        $video.style.display = "none";
      }
      $coverImg.style.display = "none";
      $placeholder.style.display = "";
    }
  }

  // ════════════════════════════════════════════════════════════
  // COVER IMAGE (썸네일 / 오디오 전용 배경)
  // ════════════════════════════════════════════════════════════
  async function _checkExistingCover() {
    try {
      const r = await fetch("/api/cover");
      if (r.ok && r.status === 200) {
        const blob = await r.blob();
        if (blob.size > 0) {
          $coverImg.src = URL.createObjectURL(blob);
          hasCoverImage = true;
          $coverRemoveBtn.style.display = "";
          updateVideoPreview();
        }
      }
    } catch (e) {
      /* ignore */
    }
  }

  async function onCoverSelect(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = "";
    const fd = new FormData();
    fd.append("image", file);
    try {
      const r = await fetch("/api/cover/upload", { method: "POST", body: fd });
      if (!r.ok) {
        const d = await r.json();
        $tlStatus.textContent = `커버 오류: ${d.error}`;
        return;
      }
      // 성공 → 미리보기 갱신
      $coverImg.src = "/api/cover?" + Date.now();
      hasCoverImage = true;
      $coverRemoveBtn.style.display = "";
      updateVideoPreview();
      $tlStatus.textContent = "커버 이미지 설정 완료";
    } catch (err) {
      $tlStatus.textContent = `커버 업로드 실패: ${err.message}`;
    }
  }

  async function onCoverRemove() {
    try {
      await fetch("/api/cover", { method: "DELETE" });
    } catch (e) {
      /* ignore */
    }
    hasCoverImage = false;
    $coverImg.removeAttribute("src");
    $coverImg.style.display = "none";
    $coverRemoveBtn.style.display = "none";
    updateVideoPreview();
    $tlStatus.textContent = "커버 이미지 제거됨";
  }

  // ════════════════════════════════════════════════════════════
  // EXPORT
  // ════════════════════════════════════════════════════════════
  async function startExport() {
    if (S.clips.length === 0) {
      $tlStatus.textContent = "타임라인에 클립이 없습니다";
      return;
    }
    const fmt = document.getElementById("export-format").value;
    const fnInput = document.getElementById("export-filename");
    const filename = (fnInput && fnInput.value.trim()) || "export";
    const clips = S.clips.map((c) => ({
      fileId: c.fileId,
      offset: c.offset,
      trimStart: c.trimStart,
      trimEnd: c.trimEnd,
      track: c.track,
      volume: c.volume,
      speed: c.speed,
    }));
    $tlStatus.textContent = "내보내기 시작…";
    $exportProgress.style.display = "flex";
    $exportFill.style.width = "0%";
    $exportText.textContent = "0%";

    const duration = getTotalDuration();
    try {
      const r = await fetch("/api/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clips, format: fmt, filename, duration }),
      });
      if (!r.ok) {
        const d = await r.json();
        $tlStatus.textContent = `오류: ${d.error || "알 수 없음"}`;
        return;
      }
      pollExport();
    } catch (e) {
      $tlStatus.textContent = `내보내기 오류: ${e.message}`;
    }
  }

  function pollExport() {
    const iv = setInterval(async () => {
      try {
        const r = await fetch("/api/export/status");
        const d = await r.json();
        $exportFill.style.width = d.progress + "%";
        $exportText.textContent = Math.round(d.progress) + "%";
        $tlStatus.textContent = d.message;
        if (!d.running) {
          clearInterval(iv);
          if (d.progress >= 100) {
            // Download
            const a = document.createElement("a");
            a.href = "/api/export/download";
            a.download = "";
            document.body.appendChild(a);
            a.click();
            a.remove();
            $tlStatus.textContent = "내보내기 완료!";
          }
          setTimeout(() => {
            $exportProgress.style.display = "none";
          }, 3000);
        }
      } catch {
        clearInterval(iv);
        $tlStatus.textContent = "상태 확인 실패";
      }
    }, 500);
  }

  // ════════════════════════════════════════════════════════════
  // KEYBOARD SHORTCUTS
  // ════════════════════════════════════════════════════════════
  function onKeyDown(e) {
    // Ignore when typing in inputs
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;

    switch (e.key) {
      case " ":
        e.preventDefault();
        playback.toggle();
        break;
      case "v":
      case "V":
        setTool("select");
        break;
      case "c":
      case "C":
        setTool("razor");
        break;
      case "Delete":
      case "Backspace":
        if (S.selClipId >= 0) removeClip(S.selClipId);
        break;
      case "Home":
        playback.seek(0);
        break;
      case "End":
        playback.seek(getTotalDuration());
        break;
      case "ArrowLeft":
        e.preventDefault();
        playback.seek(Math.max(0, S.playhead - (e.shiftKey ? 1 : 1 / 60)));
        break;
      case "ArrowRight":
        e.preventDefault();
        playback.seek(S.playhead + (e.shiftKey ? 1 : 1 / 60));
        break;
      case "i":
      case "I":
        if (e.ctrlKey) {
          e.preventDefault();
          $fileInput.click();
        }
        break;
      case "=":
      case "+":
        if (e.ctrlKey) {
          e.preventDefault();
          zoomStep(1);
        }
        break;
      case "-":
        if (e.ctrlKey) {
          e.preventDefault();
          zoomStep(-1);
        }
        break;
      case "s":
      case "S":
        if (e.ctrlKey) {
          e.preventDefault();
          saveProject();
        }
        break;
      case "o":
      case "O":
        if (e.ctrlKey) {
          e.preventDefault();
          document.getElementById("project-file-input").click();
        }
        break;
      case "0":
        if (e.ctrlKey) {
          e.preventDefault();
          zoomFit();
        }
        break;
      case "z":
      case "Z":
        if (e.ctrlKey) {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        }
        break;
      case "y":
      case "Y":
        if (e.ctrlKey) {
          e.preventDefault();
          redo();
        }
        break;
    }
  }

  function setTool(tool) {
    S.tool = tool;
    document.querySelectorAll(".tool-btn").forEach((b) => b.classList.toggle("active", b.dataset.tool === tool));
  }

  // ════════════════════════════════════════════════════════════
  // SETTINGS MODAL
  // ════════════════════════════════════════════════════════════
  async function openSettings() {
    const overlay = document.getElementById("settings-overlay");
    const $projDir = document.getElementById("set-project-dir");
    const $expDir = document.getElementById("set-export-dir");
    // 현재 설정 불러오기
    try {
      const r = await fetch("/api/settings");
      const s = await r.json();
      $projDir.value = s.projectDir || "";
      $expDir.value = s.exportDir || "";
    } catch (e) {
      $projDir.value = "";
      $expDir.value = "";
    }
    overlay.style.display = "flex";

    // 폴더 브라우즈 버튼
    const projBrowse = document.getElementById("set-project-browse");
    const expBrowse = document.getElementById("set-export-browse");

    function onProjBrowse() {
      browseFolder($projDir.value, "프로젝트 저장 폴더 선택").then((p) => {
        if (p) $projDir.value = p;
      });
    }
    function onExpBrowse() {
      browseFolder($expDir.value, "내보내기 저장 폴더 선택").then((p) => {
        if (p) $expDir.value = p;
      });
    }

    projBrowse.onclick = onProjBrowse;
    expBrowse.onclick = onExpBrowse;

    // 저장
    document.getElementById("set-save").onclick = async () => {
      try {
        const r = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectDir: $projDir.value, exportDir: $expDir.value }),
        });
        const d = await r.json();
        if (d.status === "ok") {
          $tlStatus.textContent = "설정 저장 완료";
        } else {
          $tlStatus.textContent = `설정 오류: ${d.error || "알 수 없음"}`;
        }
      } catch (e) {
        $tlStatus.textContent = `설정 저장 오류: ${e.message}`;
      }
      overlay.style.display = "none";
    };

    // 취소
    document.getElementById("set-cancel").onclick = () => {
      overlay.style.display = "none";
    };

    // 배경 클릭으로 닫기
    overlay.onclick = (e) => {
      if (e.target === overlay) overlay.style.display = "none";
    };
  }

  async function browseFolder(initialDir, title) {
    try {
      const r = await fetch("/api/settings/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initialDir: initialDir || "", title: title || "폴더 선택" }),
      });
      const d = await r.json();
      return d.path || "";
    } catch {
      return "";
    }
  }

  // ════════════════════════════════════════════════════════════
  // PROJECT SAVE / LOAD
  // ════════════════════════════════════════════════════════════
  async function saveProject() {
    const name = prompt("프로젝트 이름을 입력하세요:", S._projectName || "project");
    if (!name) return;
    S._projectName = name;

    const clips = S.clips.map((c) => ({
      fileId: c.fileId,
      track: c.track,
      offset: c.offset,
      trimStart: c.trimStart,
      trimEnd: c.trimEnd,
      volume: c.volume,
      speed: c.speed,
      color: c.color,
    }));

    try {
      $tlStatus.textContent = "저장 중…";
      const r = await fetch("/api/project/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, clips, tracks: S.tracks }),
      });
      const d = await r.json();
      if (d.status === "ok") {
        $tlStatus.textContent = `프로젝트 저장 완료: ${name}.meproj`;
        // 브라우저 다운로드도 제공
        const blob = new Blob([JSON.stringify({ version: 1, name, files: S.files, clips, tracks: S.tracks }, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${name}.meproj`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } else {
        $tlStatus.textContent = `저장 오류: ${d.error || "알 수 없음"}`;
      }
    } catch (e) {
      $tlStatus.textContent = `저장 오류: ${e.message}`;
    }
  }

  async function loadProjectFile(file) {
    try {
      $tlStatus.textContent = "프로젝트 불러오는 중…";
      const fd = new FormData();
      fd.append("project", file);
      const r = await fetch("/api/project/load", { method: "POST", body: fd });
      const d = await r.json();
      if (d.error) {
        $tlStatus.textContent = `불러오기 오류: ${d.error}`;
        return;
      }
      applyProjectData(d);
    } catch (e) {
      $tlStatus.textContent = `불러오기 오류: ${e.message}`;
    }
  }

  function applyProjectData(d) {
    // 기존 상태 초기화
    playback.stop();
    S.clips = [];
    S.selClipId = -1;
    S.playhead = 0;
    $fileList.innerHTML = "";
    Object.keys(S.files).forEach((k) => delete S.files[k]);
    Object.keys(waveforms).forEach((k) => delete waveforms[k]);

    // 파일 복원
    for (const [fid, finfo] of Object.entries(d.files || {})) {
      S.files[fid] = finfo;
      addFileToProject(finfo);
      if (finfo.hasAudio) fetchWaveform(fid);
    }

    // 트랙 수 복원
    S.tracks = d.tracks || 1;

    // 클립 복원
    for (const cd of d.clips || []) {
      if (!S.files[cd.fileId]) continue; // 누락된 파일은 건너뛰
      const clip = new Clip(cd.fileId, cd.track || 0, cd.offset || 0);
      clip.trimStart = cd.trimStart ?? 0;
      clip.trimEnd = cd.trimEnd ?? S.files[cd.fileId].duration;
      clip.volume = cd.volume ?? 100;
      clip.speed = cd.speed ?? 1.0;
      if (cd.color) clip.color = cd.color;
      S.clips.push(clip);
    }

    S._projectName = d.name || "project";

    // 누락 파일 경고
    if (d.missingFiles && d.missingFiles.length > 0) {
      $tlStatus.textContent = `프로젝트 로드 완료 (누락: ${d.missingFiles.join(", ")})`;
      alert(`다음 파일을 찾을 수 없습니다:\n${d.missingFiles.join("\n")}`);
    } else {
      $tlStatus.textContent = `프로젝트 로드 완료: ${d.name}`;
    }

    updateProperties();
    requestRender();
  }

  // ════════════════════════════════════════════════════════════
  // RESIZE HANDLE (Timeline vertical)
  // ════════════════════════════════════════════════════════════
  function initResizer() {
    const handle = document.getElementById("resize-handle");
    const tl = document.getElementById("timeline-panel");
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startY = e.clientY;
      const startH = tl.offsetHeight;
      function onM(ev) {
        tl.style.height = Math.max(150, startH + (startY - ev.clientY)) + "px";
        resizeCanvas();
      }
      function onU() {
        document.removeEventListener("mousemove", onM);
        document.removeEventListener("mouseup", onU);
      }
      document.addEventListener("mousemove", onM);
      document.addEventListener("mouseup", onU);
    });
  }

  // ════════════════════════════════════════════════════════════
  // PANEL RESIZERS (Left & Right horizontal)
  // ════════════════════════════════════════════════════════════
  function initPanelResizers() {
    // Left resizer: between project-panel and preview-panel
    const leftHandle = document.getElementById("panel-resize-left");
    const projectPanel = document.getElementById("project-panel");
    if (leftHandle && projectPanel) {
      leftHandle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        leftHandle.classList.add("active");
        const startX = e.clientX;
        const startW = projectPanel.offsetWidth;
        function onM(ev) {
          const newW = Math.max(140, Math.min(500, startW + (ev.clientX - startX)));
          projectPanel.style.width = newW + "px";
        }
        function onU() {
          leftHandle.classList.remove("active");
          document.removeEventListener("mousemove", onM);
          document.removeEventListener("mouseup", onU);
        }
        document.addEventListener("mousemove", onM);
        document.addEventListener("mouseup", onU);
      });
    }

    // Right resizer: between preview-panel and props-panel
    const rightHandle = document.getElementById("panel-resize-right");
    const propsPanel = document.getElementById("props-panel");
    if (rightHandle && propsPanel) {
      rightHandle.addEventListener("mousedown", (e) => {
        e.preventDefault();
        rightHandle.classList.add("active");
        const startX = e.clientX;
        const startW = propsPanel.offsetWidth;
        function onM(ev) {
          const newW = Math.max(180, Math.min(450, startW - (ev.clientX - startX)));
          propsPanel.style.width = newW + "px";
        }
        function onU() {
          rightHandle.classList.remove("active");
          document.removeEventListener("mousemove", onM);
          document.removeEventListener("mouseup", onU);
        }
        document.addEventListener("mousemove", onM);
        document.addEventListener("mouseup", onU);
      });
    }
  }

  // ════════════════════════════════════════════════════════════
  // PROPS PANEL TOGGLE
  // ════════════════════════════════════════════════════════════
  function initPropsToggle() {
    const propsPanel = document.getElementById("props-panel");
    const rightHandle = document.getElementById("panel-resize-right");
    const btnClose = document.getElementById("btn-toggle-props");
    const btnShow = document.getElementById("btn-show-props");

    if (btnClose) {
      btnClose.addEventListener("click", () => {
        propsPanel.classList.add("hidden");
        if (rightHandle) rightHandle.classList.add("hidden");
        if (btnShow) btnShow.style.display = "";
      });
    }
    if (btnShow) {
      btnShow.addEventListener("click", () => {
        propsPanel.classList.remove("hidden");
        if (rightHandle) rightHandle.classList.remove("hidden");
        btnShow.style.display = "none";
      });
    }
  }

  // ════════════════════════════════════════════════════════════
  // SCROLLBAR
  // ════════════════════════════════════════════════════════════
  function initScrollbar() {
    let dragging = false,
      dragStartX = 0,
      dragStartScroll = 0;

    $scrollThumb.addEventListener("mousedown", (e) => {
      e.preventDefault();
      dragging = true;
      dragStartX = e.clientX;
      dragStartScroll = S.scrollX;
      $scrollThumb.style.cursor = "grabbing";
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const barW = $scrollbar.offsetWidth;
      const totalPx = getTotalTimelinePx();
      const visW = S.canvasW - CFG.HEADER_W;
      if (totalPx <= visW) return;
      const ratio = totalPx / barW;
      const dx = e.clientX - dragStartX;
      S.scrollX = Math.max(0, Math.min(totalPx - visW, dragStartScroll + dx * ratio));
      requestRender();
    });

    document.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        $scrollThumb.style.cursor = "grab";
      }
    });

    $scrollbar.addEventListener("click", (e) => {
      if (e.target === $scrollThumb) return;
      const rect = $scrollbar.getBoundingClientRect();
      const clickRatio = (e.clientX - rect.left) / rect.width;
      const totalPx = getTotalTimelinePx();
      const visW = S.canvasW - CFG.HEADER_W;
      S.scrollX = Math.max(0, Math.min(totalPx - visW, clickRatio * totalPx - visW / 2));
      requestRender();
    });
  }

  function getTotalTimelinePx() {
    return (getTotalDuration() + 5) * S.pps;
  }

  // ════════════════════════════════════════════════════════════
  // VERTICAL SCROLLBAR
  // ════════════════════════════════════════════════════════════
  function initVScrollbar() {
    if (!$vScrollbar || !$vScrollThumb) return;
    let dragging = false,
      dragStartY = 0,
      dragStartScroll = 0;

    $vScrollThumb.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      dragStartY = e.clientY;
      dragStartScroll = S.scrollY;
      $vScrollThumb.style.cursor = "grabbing";
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const barH = $vScrollbar.offsetHeight;
      const totalH = getTotalTracksPx();
      const visH = S.canvasH - CFG.RULER_H;
      if (totalH <= visH) return;
      const ratio = totalH / barH;
      const dy = e.clientY - dragStartY;
      S.scrollY = Math.max(0, Math.min(totalH - visH, dragStartScroll + dy * ratio));
      requestRender();
    });

    document.addEventListener("mouseup", () => {
      if (dragging) {
        dragging = false;
        $vScrollThumb.style.cursor = "grab";
      }
    });

    $vScrollbar.addEventListener("click", (e) => {
      if (e.target === $vScrollThumb) return;
      const rect = $vScrollbar.getBoundingClientRect();
      const clickRatio = (e.clientY - rect.top) / rect.height;
      const totalH = getTotalTracksPx();
      const visH = S.canvasH - CFG.RULER_H;
      S.scrollY = Math.max(0, Math.min(totalH - visH, clickRatio * totalH - visH / 2));
      requestRender();
    });
  }

  function getTotalTracksPx() {
    return S.tracks * (CFG.TRACK_H + CFG.TRACK_GAP) + 20;
  }

  function updateVScrollbar() {
    if (!$vScrollbar || !$vScrollThumb) return;
    const totalH = getTotalTracksPx();
    const visH = S.canvasH - CFG.RULER_H;
    const barH = $vScrollbar.offsetHeight;

    if (totalH <= visH || barH <= 0) {
      $vScrollThumb.style.display = "none";
      return;
    }
    $vScrollThumb.style.display = "block";

    const thumbH = Math.max(20, (visH / totalH) * barH);
    const maxTop = barH - thumbH;
    const scrollRatio = S.scrollY / (totalH - visH);
    const top = scrollRatio * maxTop;

    $vScrollThumb.style.height = thumbH + "px";
    $vScrollThumb.style.top = Math.max(0, Math.min(maxTop, top)) + "px";
  }

  function updateScrollbar() {
    const totalPx = getTotalTimelinePx();
    const visW = S.canvasW - CFG.HEADER_W;
    const barW = $scrollbar.offsetWidth;

    if (totalPx <= visW || barW <= 0) {
      $scrollThumb.style.display = "none";
      return;
    }
    $scrollThumb.style.display = "block";

    const thumbW = Math.max(30, (visW / totalPx) * barW);
    const maxLeft = barW - thumbW;
    const scrollRatio = S.scrollX / (totalPx - visW);
    const left = scrollRatio * maxLeft;

    $scrollThumb.style.width = thumbW + "px";
    $scrollThumb.style.left = Math.max(0, Math.min(maxLeft, left)) + "px";
  }

  // ════════════════════════════════════════════════════════════
  // PLAY BUTTON TOGGLE
  // ════════════════════════════════════════════════════════════
  function _updatePlayBtn() {
    document.getElementById("btn-play").textContent = S.playing ? "⏸" : "▶";
  }

  // ════════════════════════════════════════════════════════════
  // UTILITIES
  // ════════════════════════════════════════════════════════════
  function fmtTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0")}`;
  }

  function fmtTimeShort(s) {
    if (s < 60) return s.toFixed(1) + "s";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, "0")}`;
  }

  function esc(str) {
    const d = document.createElement("div");
    d.textContent = str;
    return d.innerHTML;
  }

  // ════════════════════════════════════════════════════════════
  // START
  // ════════════════════════════════════════════════════════════
  document.addEventListener("DOMContentLoaded", init);
})();
