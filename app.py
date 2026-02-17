"""
Media Editor – Flask Server
mp3/mp4 파일 관리, 파형 생성, ffmpeg 내보내기
실행: python app.py
"""

import os, json, struct, hashlib, threading, subprocess
from flask import Flask, render_template, jsonify, request, send_file

app = Flask(__name__)
app.config['MAX_CONTENT_LENGTH'] = 4 * 1024 * 1024 * 1024  # 4GB

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = os.path.join(BASE_DIR, 'workspace')
os.makedirs(WORKSPACE, exist_ok=True)

# ─── FFmpeg ───────────────────────────────────────────────
def _find(name):
    for p in [rf'C:\ffmpeg\bin\{name}.exe', name]:
        try:
            subprocess.run([p, '-version'], capture_output=True,
                           creationflags=subprocess.CREATE_NO_WINDOW)
            return p
        except Exception:
            pass
    return name

FFMPEG  = _find('ffmpeg')
FFPROBE = _find('ffprobe')

def _atempo_chain(speed):
    """Build chained atempo filters for the given speed (0.1~10)."""
    if abs(speed - 1.0) < 0.001:
        return ""
    parts = []
    s = speed
    while s < 0.5:
        parts.append("atempo=0.5")
        s /= 0.5
    while s > 2.0:
        parts.append("atempo=2.0")
        s /= 2.0
    parts.append(f"atempo={s:.6f}")
    return "," + ",".join(parts)
# ─── 설정 ───────────────────────────────────────────
SETTINGS_FILE = os.path.join(BASE_DIR, 'settings.json')

def _load_settings():
    defaults = {
        'projectDir': os.path.join(WORKSPACE, '_projects'),
        'exportDir': WORKSPACE,
    }
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, 'r', encoding='utf-8') as fp:
                saved = json.load(fp)
            defaults.update(saved)
        except Exception:
            pass
    return defaults

def _save_settings(settings):
    with open(SETTINGS_FILE, 'w', encoding='utf-8') as fp:
        json.dump(settings, fp, ensure_ascii=False, indent=2)

settings = _load_settings()
# ─── 상태 ─────────────────────────────────────────────────
files_db = {}                       # fid → file info dict
export_state = {'running': False, 'progress': 0, 'message': '', 'path': ''}

def _fid(path):
    return hashlib.md5(path.encode()).hexdigest()[:12]

def _probe(path):
    cmd = [FFPROBE, '-v', 'quiet', '-print_format', 'json',
           '-show_format', '-show_streams', path]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True,
                           encoding='utf-8', errors='replace',
                           creationflags=subprocess.CREATE_NO_WINDOW)
        return json.loads(r.stdout)
    except Exception:
        return None

# ─── 라우트 ───────────────────────────────────────────────
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/upload', methods=['POST'])
def upload_files():
    results = []
    for f in request.files.getlist('files'):
        name = f.filename
        ext = os.path.splitext(name)[1].lower()
        if ext not in ('.mp3', '.mp4'):
            continue
        save_path = os.path.join(WORKSPACE, name)
        base = os.path.splitext(name)[0]
        i = 1
        while os.path.exists(save_path):
            save_path = os.path.join(WORKSPACE, f"{base}_{i}{ext}")
            i += 1
        f.save(save_path)

        fid = _fid(save_path)
        info = _probe(save_path)
        if not info:
            continue

        fmt = info.get('format', {})
        duration = float(fmt.get('duration', 0))
        has_video = has_audio = False
        width = height = 0
        for s in info.get('streams', []):
            ct = s.get('codec_type', '')
            if ct == 'video' and s.get('codec_name') not in ('mjpeg', 'png'):
                has_video = True
                width  = int(s.get('width', 0))
                height = int(s.get('height', 0))
            elif ct == 'audio':
                has_audio = True
        if duration <= 0:
            continue

        entry = dict(id=fid, path=save_path, name=os.path.basename(save_path),
                     duration=round(duration, 3),
                     hasVideo=has_video, hasAudio=has_audio,
                     width=width, height=height)
        files_db[fid] = entry
        results.append(entry)
    return jsonify(results)

@app.route('/api/files')
def list_files():
    return jsonify(list(files_db.values()))

@app.route('/api/media/<fid>')
def serve_media(fid):
    if fid not in files_db:
        return 'Not found', 404
    path = files_db[fid]['path']
    ext = os.path.splitext(path)[1].lower()
    mime = {'.mp4': 'video/mp4', '.mp3': 'audio/mpeg'}.get(ext, 'application/octet-stream')
    return send_file(path, mimetype=mime, conditional=True)

@app.route('/api/waveform/<fid>')
def waveform(fid):
    if fid not in files_db:
        return 'Not found', 404
    cache = os.path.join(WORKSPACE, f'{fid}.peaks.json')
    if os.path.exists(cache):
        with open(cache) as fp:
            return jsonify(json.load(fp))

    path = files_db[fid]['path']
    cmd = [FFMPEG, '-i', path, '-ac', '1', '-ar', '8000',
           '-f', 's16le', '-acodec', 'pcm_s16le', '-v', 'quiet', 'pipe:1']
    r = subprocess.run(cmd, capture_output=True,
                       creationflags=subprocess.CREATE_NO_WINDOW)
    data = r.stdout
    samples = []
    for i in range(0, len(data) - 1, 2):
        samples.append(abs(struct.unpack_from('<h', data, i)[0]))

    num = 800
    if not samples:
        peaks = []
    else:
        chunk = max(1, len(samples) // num)
        peaks = []
        for i in range(0, len(samples), chunk):
            peaks.append(round(max(samples[i:i + chunk]) / 32768.0, 4))
        peaks = peaks[:num]

    result = {'peaks': peaks, 'duration': files_db[fid]['duration']}
    with open(cache, 'w') as fp:
        json.dump(result, fp)
    return jsonify(result)

# ─── 설정 API ───────────────────────────────────────
@app.route('/api/settings', methods=['GET'])
def get_settings():
    return jsonify(settings)

@app.route('/api/settings', methods=['POST'])
def update_settings():
    global settings
    data = request.json
    if 'projectDir' in data:
        p = data['projectDir'].strip()
        if p:
            settings['projectDir'] = p
            os.makedirs(p, exist_ok=True)
    if 'exportDir' in data:
        p = data['exportDir'].strip()
        if p:
            settings['exportDir'] = p
            os.makedirs(p, exist_ok=True)
    _save_settings(settings)
    return jsonify({'status': 'ok', **settings})

@app.route('/api/settings/browse', methods=['POST'])
def browse_folder():
    """Open native folder picker (tkinter)"""
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()
        root.attributes('-topmost', True)
        data = request.json or {}
        initial = data.get('initialDir', '')
        title = data.get('title', '폴더 선택')
        folder = filedialog.askdirectory(title=title, initialdir=initial or None)
        root.destroy()
        if folder:
            return jsonify({'path': folder})
        return jsonify({'path': ''})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# ─── 프로젝트 저장/불러오기 ────────────────────────────
def _get_projects_dir():
    d = settings.get('projectDir', os.path.join(WORKSPACE, '_projects'))
    os.makedirs(d, exist_ok=True)
    return d

@app.route('/api/project/save', methods=['POST'])
def project_save():
    """프로젝트를 .meproj (JSON) 파일로 저장"""
    data = request.json
    name = (data.get('name') or 'project').strip()
    import re as _re
    safe = _re.sub(r'[<>:"/\\|?*]', '_', name).strip() or 'project'
    proj_path = os.path.join(_get_projects_dir(), f'{safe}.meproj')

    # 사용 중인 파일 정보만 포함
    used_fids = set()
    for c in data.get('clips', []):
        used_fids.add(c.get('fileId'))
    file_entries = {fid: files_db[fid] for fid in used_fids if fid in files_db}

    proj = {
        'version': 1,
        'name': name,
        'files': file_entries,
        'clips': data.get('clips', []),
        'tracks': data.get('tracks', 1),
    }
    with open(proj_path, 'w', encoding='utf-8') as fp:
        json.dump(proj, fp, ensure_ascii=False, indent=2)
    return jsonify({'status': 'ok', 'path': proj_path, 'name': safe})

@app.route('/api/project/load', methods=['POST'])
def project_load():
    """저장된 .meproj 파일 불러오기"""
    f = request.files.get('project')
    if not f:
        return jsonify({'error': '파일이 없습니다'}), 400
    try:
        proj = json.loads(f.read().decode('utf-8'))
    except Exception as e:
        return jsonify({'error': f'파일 파싱 오류: {e}'}), 400

    # 파일 DB에 미디어 파일 복원
    restored_files = {}
    missing_files = []
    for fid, finfo in proj.get('files', {}).items():
        path = finfo.get('path', '')
        if os.path.exists(path):
            files_db[fid] = finfo
            restored_files[fid] = finfo
        else:
            missing_files.append(finfo.get('name', fid))

    return jsonify({
        'status': 'ok',
        'name': proj.get('name', 'project'),
        'files': restored_files,
        'clips': proj.get('clips', []),
        'tracks': proj.get('tracks', 1),
        'missingFiles': missing_files,
    })

@app.route('/api/project/list')
def project_list():
    """저장된 프로젝트 목록"""
    projects = []
    pdir = _get_projects_dir()
    if os.path.isdir(pdir):
        for fname in os.listdir(pdir):
            if fname.endswith('.meproj'):
                fpath = os.path.join(pdir, fname)
                try:
                    with open(fpath, 'r', encoding='utf-8') as fp:
                        p = json.load(fp)
                    projects.append({
                        'name': p.get('name', fname),
                        'filename': fname,
                        'tracks': p.get('tracks', 0),
                        'clips': len(p.get('clips', [])),
                        'files': len(p.get('files', {})),
                    })
                except Exception:
                    pass
    return jsonify(projects)

@app.route('/api/project/open/<filename>')
def project_open(filename):
    """서버에 저장된 프로젝트 파일 직접 열기"""
    import re as _re
    safe = _re.sub(r'[<>:"/\\|?*]', '_', filename).strip()
    fpath = os.path.join(_get_projects_dir(), safe)
    if not os.path.exists(fpath):
        return jsonify({'error': '파일을 찾을 수 없습니다'}), 404
    try:
        with open(fpath, 'r', encoding='utf-8') as fp:
            proj = json.load(fp)
    except Exception as e:
        return jsonify({'error': f'파싱 오류: {e}'}), 400

    restored_files = {}
    missing_files = []
    for fid, finfo in proj.get('files', {}).items():
        path = finfo.get('path', '')
        if os.path.exists(path):
            files_db[fid] = finfo
            restored_files[fid] = finfo
        else:
            missing_files.append(finfo.get('name', fid))

    return jsonify({
        'status': 'ok',
        'name': proj.get('name', 'project'),
        'files': restored_files,
        'clips': proj.get('clips', []),
        'tracks': proj.get('tracks', 1),
        'missingFiles': missing_files,
    })

# ─── 내보내기 ─────────────────────────────────────────────
@app.route('/api/export', methods=['POST'])
def start_export():
    global export_state
    if export_state['running']:
        return jsonify({'error': 'Already running'}), 400

    data = request.json
    clips = data.get('clips', [])
    fmt   = data.get('format', 'mp4')
    duration = data.get('duration', None)
    raw_name = data.get('filename', 'export') or 'export'
    # 파일명에서 위험문자 제거
    import re as _re
    safe_name = _re.sub(r'[<>:"/\\|?*]', '_', raw_name).strip() or 'export'
    if not clips:
        return jsonify({'error': 'No clips'}), 400

    export_dir = settings.get('exportDir', WORKSPACE)
    os.makedirs(export_dir, exist_ok=True)
    out_path = os.path.join(export_dir, f'{safe_name}.{fmt}')
    export_state = dict(running=True, progress=0, message='시작...', path=out_path)
    threading.Thread(target=_do_export, args=(clips, out_path, fmt, duration), daemon=True).start()
    return jsonify({'status': 'started'})

@app.route('/api/export/status')
def get_export_status():
    return jsonify(export_state)

@app.route('/api/export/download')
def export_download():
    path = export_state.get('path', '')
    if not path or not os.path.exists(path):
        return 'Not ready', 404
    return send_file(path, as_attachment=True)

def _do_export(clips, out_path, fmt, duration=None):
    global export_state
    try:
        has_video = any(files_db.get(c['fileId'], {}).get('hasVideo') for c in clips)
        audio_only = fmt == 'mp3' or not has_video

        cmd = [FFMPEG, '-y']
        input_map = {}
        for c in clips:
            fid = c['fileId']
            if fid not in input_map:
                input_map[fid] = len(input_map)
                cmd.extend(['-i', files_db[fid]['path']])

        parts, audio_labels, video_entries = [], [], []

        # ── 타임라인 총 길이: 프론트엔드에서 전달받은 값 우선 사용 ──
        if duration and duration > 0:
            timeline_dur = float(duration)
        else:
            timeline_dur = 0.0
            for c in clips:
                fid = c['fileId']
                entry = files_db[fid]
                ts_ = c.get('trimStart', 0)
                te_ = c.get('trimEnd', entry['duration'])
                spd_ = c.get('speed', 1.0)
                end_pos = c['offset'] + (te_ - ts_) / spd_
                timeline_dur = max(timeline_dur, end_pos)
        print(f'[EXPORT] timeline_dur={timeline_dur:.3f}s', flush=True)

        for i, c in enumerate(clips):
            fid  = c['fileId']
            inp  = input_map[fid]
            entry = files_db[fid]
            off_ms = max(0, int(c['offset'] * 1000))
            ts = c.get('trimStart', 0)
            te = c.get('trimEnd', entry['duration'])

            if entry['hasAudio']:
                vol = c.get('volume', 100)
                speed = c.get('speed', 1.0)
                delay = f",adelay={off_ms}:all=1" if off_ms > 0 else ""
                vol_f = f",volume={vol / 100:.2f}" if vol != 100 else ""
                speed_f = _atempo_chain(speed)
                parts.append(f"[{inp}:a]atrim=start={ts}:end={te},"
                             f"asetpts=PTS-STARTPTS{speed_f}{delay}{vol_f}[a{i}]")
                audio_labels.append(f"[a{i}]")

            if not audio_only and entry['hasVideo']:
                video_entries.append((c['offset'], inp, i, ts, te, c.get('speed', 1.0)))

        # 오디오 믹스
        if len(audio_labels) == 1:
            final_a = audio_labels[0]
        elif len(audio_labels) > 1:
            parts.append(f"{''.join(audio_labels)}amix=inputs={len(audio_labels)}:"
                         f"duration=longest:dropout_transition=0:normalize=0[outa]")
            final_a = "[outa]"
        else:
            final_a = None

        # ── 비디오: 검은화면 채움 + 해상도 통일 후 concat ──
        final_v = None
        if not audio_only and video_entries:
            video_entries.sort()
            # 모든 비디오 클립 중 최대 해상도 구하기
            max_w, max_h = 0, 0
            for _, inp, i, ts, te, speed in video_entries:
                for fid, idx in input_map.items():
                    if idx == inp:
                        entry = files_db[fid]
                        max_w = max(max_w, entry.get('width', 0))
                        max_h = max(max_h, entry.get('height', 0))
                        break
            if max_w == 0 or max_h == 0:
                max_w, max_h = 1920, 1080  # fallback

            # 짝수 보장
            max_w = max_w + (max_w % 2)
            max_h = max_h + (max_h % 2)

            # 비디오 세그먼트 목록 구성 (검은화면 갭 + 클립)
            segments = []  # ('black', duration) | ('clip', inp, i, ts, te, speed)
            current_pos = 0.0
            for offset, inp, i, ts, te, speed in video_entries:
                clip_dur = (te - ts) / speed
                gap = offset - current_pos
                if gap > 0.01:
                    segments.append(('black', gap))
                segments.append(('clip', inp, i, ts, te, speed))
                current_pos = offset + clip_dur

            # 마지막 클립 후 → 타임라인 끝까지 검은화면
            tail_gap = timeline_dur - current_pos
            if tail_gap > 0.01:
                segments.append(('black', tail_gap))

            seg_labels = []
            black_idx = 0
            for seg in segments:
                if seg[0] == 'black':
                    dur = seg[1]
                    label = f"blk{black_idx}"
                    parts.append(
                        f"color=c=black:s={max_w}x{max_h}:d={dur:.6f}:r=30,"
                        f"setsar=1[{label}]"
                    )
                    seg_labels.append(f"[{label}]")
                    black_idx += 1
                else:
                    _, inp, i, ts, te, speed = seg
                    spd_v = f",setpts={1.0/speed:.6f}*PTS" if abs(speed - 1.0) > 0.001 else ""
                    parts.append(
                        f"[{inp}:v]trim=start={ts}:end={te},setpts=PTS-STARTPTS{spd_v},"
                        f"scale={max_w}:{max_h}:force_original_aspect_ratio=decrease,"
                        f"pad={max_w}:{max_h}:(ow-iw)/2:(oh-ih)/2,setsar=1[v{i}]"
                    )
                    seg_labels.append(f"[v{i}]")

            if len(seg_labels) == 1:
                final_v = seg_labels[0]
            else:
                parts.append(f"{''.join(seg_labels)}concat=n={len(seg_labels)}:v=1:a=0[outv]")
                final_v = "[outv]"

        if parts:
            cmd += ['-filter_complex', ';'.join(parts)]
        if final_v:
            cmd += ['-map', final_v]
        if final_a:
            cmd += ['-map', final_a]
        # 타임라인 길이로 출력 제한
        cmd += ['-t', f'{timeline_dur:.6f}']
        cmd.append(out_path)

        export_state['message'] = '인코딩 중...'
        import shlex
        print(f'[EXPORT CMD] {" ".join(shlex.quote(str(x)) for x in cmd)}', flush=True)
        proc = subprocess.Popen(cmd, stderr=subprocess.PIPE, text=True,
                                encoding='utf-8', errors='replace',
                                creationflags=subprocess.CREATE_NO_WINDOW)

        total = max((c['offset'] + (c.get('trimEnd', 0) - c.get('trimStart', 0)) / c.get('speed', 1.0))
                    for c in clips) if clips else 1

        stderr_lines = []
        for line in proc.stderr:
            stderr_lines.append(line.rstrip())
            if 'time=' in line:
                try:
                    ts = line.split('time=')[1].split(' ')[0]
                    h, m, s = ts.split(':')
                    cur = float(h) * 3600 + float(m) * 60 + float(s)
                    export_state['progress'] = min(99, round(cur / total * 100, 1))
                    export_state['message'] = f'인코딩 중... {export_state["progress"]}%'
                except Exception:
                    pass

        proc.wait()
        if proc.returncode == 0:
            export_state['progress'] = 100
            export_state['message'] = '완료!'
        else:
            # 마지막 20줄의 stderr를 에러 메시지에 포함
            tail = '\n'.join(stderr_lines[-20:])
            print(f'[EXPORT FAIL] returncode={proc.returncode}\n{tail}', flush=True)
            export_state['message'] = f'내보내기 실패: {tail[-200:] if tail else "unknown error"}'
    except Exception as e:
        import traceback
        traceback.print_exc()
        export_state['message'] = f'오류: {e}'
    finally:
        export_state['running'] = False

# ─── 실행 ─────────────────────────────────────────────────
if __name__ == '__main__':
    import webbrowser
    port = 5555
    url = f'http://localhost:{port}'
    print(f'\n  🎬 Media Editor')
    print(f'  📌 {url}\n')
    threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    app.run(host='127.0.0.1', port=port, debug=False, threaded=True)
