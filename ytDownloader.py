import yt_dlp
import os
import tkinter as tk
from tkinter import filedialog, messagebox
import customtkinter as ctk
from pathlib import Path
import threading
import subprocess
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

# customtkinter 테마 설정
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")

class YouTubeDownloaderGUI:
    # 색상 상수
    BG_DARK = "#1a1a2e"
    BG_CARD = "#16213e"
    ACCENT = "#5b21b6"
    ACCENT_HOVER = "#6d35c9"
    TEXT_PRIMARY = "#ffffff"
    TEXT_SECONDARY = "#a0a0b8"
    ENTRY_BG = "#0f3460"
    LISTBOX_BG = "#0f3460"
    LISTBOX_SELECT = "#5b21b6"
    PROGRESS_FG = "#5b21b6"
    PROGRESS_BG = "#0f3460"

    def __init__(self, root):
        self.root = root
        self.root.title("YouTube Downloader")
        self.root.geometry("700x780")
        self.root.resizable(True, True)
        self.root.configure(fg_color=self.BG_DARK)
        
        # 변수 초기화
        self.video_info = None
        self.video_info_single = None
        self.video_formats = []
        self.audio_formats = []
        self.displayed_video_formats = []
        self.download_path = os.path.join(os.path.expanduser("~"), "Downloads", "YouTube")
        self.is_playlist = False
        self.playlist_entries = []
        
        # FFmpeg 경로 확인
        self.check_ffmpeg()
        
        self.create_widgets()
    
    def check_ffmpeg(self):
        """FFmpeg 설치 확인"""
        try:
            subprocess.run(['ffmpeg', '-version'], 
                          capture_output=True, 
                          check=True)
            return True
        except:
            return False
    
    def _make_section(self, parent, title, row, **grid_kw):
        """섹션 프레임 생성 헬퍼"""
        label = ctk.CTkLabel(parent, text=title, font=ctk.CTkFont(size=12, weight="bold"),
                             text_color=self.TEXT_SECONDARY, anchor="w")
        label.grid(row=row, column=0, sticky="w", pady=(8, 2), padx=2)
        frame = ctk.CTkFrame(parent, fg_color=self.BG_CARD, corner_radius=12)
        frame.grid(row=row + 1, column=0, sticky="ew", pady=(0, 4), **grid_kw)
        frame.columnconfigure(0, weight=1)
        return frame

    def create_widgets(self):
        # 메인 스크롤 영역
        main_frame = ctk.CTkScrollableFrame(self.root, fg_color="transparent")
        main_frame.grid(row=0, column=0, sticky="nsew", padx=12, pady=8)
        main_frame.columnconfigure(0, weight=1)
        self.root.columnconfigure(0, weight=1)
        self.root.rowconfigure(0, weight=1)
        self.main_frame = main_frame

        # ── URL 섹션 ──
        url_section = self._make_section(main_frame, "YouTube URL", 0)
        url_inner = ctk.CTkFrame(url_section, fg_color="transparent")
        url_inner.grid(row=0, column=0, sticky="ew", padx=10, pady=10)
        url_inner.columnconfigure(0, weight=1)

        self.url_entry = ctk.CTkEntry(url_inner, placeholder_text="https://www.youtube.com/watch?v=...",
                                      height=36, corner_radius=8, fg_color=self.ENTRY_BG,
                                      border_width=0, text_color=self.TEXT_PRIMARY)
        self.url_entry.grid(row=0, column=0, sticky="ew", padx=(0, 8))

        self.fetch_btn = ctk.CTkButton(url_inner, text="정보 가져오기", width=110, height=36,
                                       corner_radius=8, fg_color=self.ACCENT,
                                       hover_color=self.ACCENT_HOVER,
                                       command=self.fetch_video_info)
        self.fetch_btn.grid(row=0, column=1)

        # ── 영상 정보 섹션 ──
        info_section = self._make_section(main_frame, "영상 정보", 2)
        self.info_text = ctk.CTkTextbox(info_section, height=80, corner_radius=8,
                                        fg_color=self.ENTRY_BG, text_color=self.TEXT_PRIMARY,
                                        font=ctk.CTkFont(size=12), border_width=0,
                                        state="disabled")
        self.info_text.grid(row=0, column=0, sticky="ew", padx=10, pady=10)

        # ── 다운로드 설정 섹션 ──
        settings_section = self._make_section(main_frame, "다운로드 설정", 4)
        settings_inner = ctk.CTkFrame(settings_section, fg_color="transparent")
        settings_inner.grid(row=0, column=0, sticky="nsew", padx=10, pady=10)
        settings_inner.columnconfigure(0, weight=0)
        settings_inner.columnconfigure(1, weight=1)

        # ── 왼쪽: 타입 + 스레드 ──
        left_col = ctk.CTkFrame(settings_inner, fg_color="transparent")
        left_col.grid(row=0, column=0, sticky="nw")

        # 타입 선택
        self.download_type = tk.StringVar(value="video")
        type_row = ctk.CTkFrame(left_col, fg_color="transparent")
        type_row.grid(row=0, column=0, sticky="w")

        ctk.CTkLabel(type_row, text="타입", font=ctk.CTkFont(size=12),
                     text_color=self.TEXT_SECONDARY).grid(row=0, column=0, padx=(0, 12))
        ctk.CTkRadioButton(type_row, text="비디오 (MP4)", variable=self.download_type,
                           value="video", command=self._on_type_change,
                           fg_color=self.ACCENT, hover_color=self.ACCENT_HOVER,
                           border_color=self.TEXT_SECONDARY, text_color=self.TEXT_PRIMARY
                           ).grid(row=0, column=1, padx=(0, 16))
        ctk.CTkRadioButton(type_row, text="오디오 (MP3)", variable=self.download_type,
                           value="audio", command=self._on_type_change,
                           fg_color=self.ACCENT, hover_color=self.ACCENT_HOVER,
                           border_color=self.TEXT_SECONDARY, text_color=self.TEXT_PRIMARY
                           ).grid(row=0, column=2)



        # 멀티스레드
        thread_row = ctk.CTkFrame(left_col, fg_color="transparent")
        thread_row.grid(row=1, column=0, sticky="w", pady=(8, 0))

        ctk.CTkLabel(thread_row, text="스레드", font=ctk.CTkFont(size=12),
                     text_color=self.TEXT_SECONDARY).grid(row=0, column=0, padx=(0, 12))
        self.thread_count = tk.IntVar(value=4)

        minus_btn = ctk.CTkButton(thread_row, text="−", width=30, height=30,
                                   corner_radius=6, fg_color=self.ENTRY_BG,
                                   hover_color="#1a4a7a", text_color=self.TEXT_PRIMARY,
                                   font=ctk.CTkFont(size=14, weight="bold"),
                                   command=lambda: self._adjust_thread(-1))
        minus_btn.grid(row=0, column=1, padx=(0, 2))

        self.thread_entry = ctk.CTkEntry(thread_row, width=45, height=30, corner_radius=8,
                                         fg_color=self.ENTRY_BG, border_width=0,
                                         text_color=self.TEXT_PRIMARY, justify="center")
        self.thread_entry.insert(0, "4")
        self.thread_entry.grid(row=0, column=2, padx=0)

        plus_btn = ctk.CTkButton(thread_row, text="+", width=30, height=30,
                                  corner_radius=6, fg_color=self.ENTRY_BG,
                                  hover_color="#1a4a7a", text_color=self.TEXT_PRIMARY,
                                  font=ctk.CTkFont(size=14, weight="bold"),
                                  command=lambda: self._adjust_thread(1))
        plus_btn.grid(row=0, column=3, padx=(2, 6))

        ctk.CTkLabel(thread_row, text="(1~12)", font=ctk.CTkFont(size=11),
                     text_color=self.TEXT_SECONDARY).grid(row=0, column=4)

        # ── 오른쪽: 저장 경로 ──
        # ── 오른쪽: 저장 경로 ──
        right_col = ctk.CTkFrame(settings_inner, fg_color="transparent")
        right_col.grid(row=0, column=1, sticky="new", padx=(40, 0))
        right_col.columnconfigure(0, weight=1)

        path_label_row = ctk.CTkFrame(right_col, fg_color="transparent")
        path_label_row.grid(row=0, column=0, sticky="w", pady=(0, 4))

        ctk.CTkLabel(path_label_row, text="저장 경로", font=ctk.CTkFont(size=12),
                     text_color=self.TEXT_SECONDARY, anchor="w"
                     ).grid(row=0, column=0, sticky="w", padx=(0, 6))

        self.browse_btn = ctk.CTkButton(path_label_row, text="찾아보기", width=70, height=24,
                                        corner_radius=6, fg_color=self.ENTRY_BG,
                                        hover_color="#1a4a7a", text_color=self.TEXT_PRIMARY,
                                        font=ctk.CTkFont(size=11),
                                        command=self.browse_folder)
        self.browse_btn.grid(row=0, column=1)

        self.path_entry = ctk.CTkEntry(right_col, height=34, corner_radius=8,
                                       fg_color=self.ENTRY_BG, border_width=0,
                                       text_color=self.TEXT_PRIMARY)
        self.path_entry.insert(0, self.download_path)
        self.path_entry.grid(row=1, column=0, sticky="ew")

        # ── 품질/해상도 선택 섹션 ──
        ctk.CTkLabel(main_frame, text="품질 / 해상도 선택",
                     font=ctk.CTkFont(size=12, weight="bold"),
                     text_color=self.TEXT_SECONDARY, anchor="w"
                     ).grid(row=6, column=0, sticky="w", pady=(8, 2), padx=2)

        format_frame = ctk.CTkFrame(main_frame, fg_color=self.BG_CARD, corner_radius=12)
        format_frame.grid(row=7, column=0, sticky="ew", pady=(0, 4))
        format_frame.columnconfigure(0, weight=1)

        self.format_listbox = tk.Listbox(
            format_frame, height=1,
            font=("Consolas", 10),
            bg=self.BG_CARD, fg=self.TEXT_PRIMARY,
            selectbackground=self.LISTBOX_SELECT, selectforeground="#ffffff",
            highlightthickness=0, bd=0, relief="flat",
            activestyle="none"
        )
        self.format_listbox.grid(row=0, column=0, sticky="ew", padx=10, pady=6)
        self.format_section = format_frame

        # ── 플레이리스트 목록 섹션 (기본 숨김) ──
        self.playlist_section_label = ctk.CTkLabel(
            main_frame, text="플레이리스트 목록",
            font=ctk.CTkFont(size=12, weight="bold"),
            text_color=self.TEXT_SECONDARY, anchor="w")
        self.playlist_section_frame = ctk.CTkFrame(main_frame, fg_color=self.BG_CARD,
                                                    corner_radius=12)
        self.playlist_section_frame.columnconfigure(0, weight=1)

        # 플레이리스트 선택 버튼 바
        pl_btn_frame = ctk.CTkFrame(self.playlist_section_frame, fg_color="transparent")
        pl_btn_frame.grid(row=0, column=0, sticky="w", padx=10, pady=(10, 4))

        ctk.CTkButton(pl_btn_frame, text="전체 선택", width=80, height=28,
                      corner_radius=6, fg_color=self.ENTRY_BG,
                      hover_color="#1a4a7a", text_color=self.TEXT_PRIMARY,
                      font=ctk.CTkFont(size=11),
                      command=self._select_all_playlist).grid(row=0, column=0, padx=(0, 6))

        ctk.CTkButton(pl_btn_frame, text="선택 해제", width=80, height=28,
                      corner_radius=6, fg_color=self.ENTRY_BG,
                      hover_color="#1a4a7a", text_color=self.TEXT_PRIMARY,
                      font=ctk.CTkFont(size=11),
                      command=self._deselect_all_playlist).grid(row=0, column=1, padx=(0, 6))

        self.pl_select_label = ctk.CTkLabel(pl_btn_frame, text="",
                                            font=ctk.CTkFont(size=11),
                                            text_color=self.TEXT_SECONDARY)
        self.pl_select_label.grid(row=0, column=2, padx=(6, 0))

        # 체크박스 스크롤 영역
        self.playlist_scroll_frame = ctk.CTkScrollableFrame(
            self.playlist_section_frame, fg_color="transparent",
            height=250)
        self.playlist_scroll_frame.grid(row=1, column=0, columnspan=2, sticky="ew",
                                        padx=6, pady=(0, 10))
        self.playlist_scroll_frame.columnconfigure(0, weight=1)

        # 플레이리스트 스크롤 시 부모 스크롤 전파 방지
        def _is_mouse_over_playlist():
            """마우스가 플레이리스트 스크롤 영역 위에 있는지 확인"""
            try:
                if not self.playlist_scroll_frame.winfo_ismapped():
                    return False
                if not self.playlist_scroll_frame.winfo_viewable():
                    return False
                w = self.playlist_scroll_frame.winfo_rootx()
                h = self.playlist_scroll_frame.winfo_rooty()
                w2 = w + self.playlist_scroll_frame.winfo_width()
                h2 = h + self.playlist_scroll_frame.winfo_height()
                mx = self.root.winfo_pointerx()
                my = self.root.winfo_pointery()
                return w <= mx <= w2 and h <= my <= h2
            except:
                return False

        def _smart_mousewheel(e):
            if _is_mouse_over_playlist():
                self.playlist_scroll_frame._parent_canvas.yview_scroll(int(-e.delta / 10), "units")
            else:
                self.main_frame._parent_canvas.yview_scroll(int(-e.delta / 10), "units")
            return "break"

        self.root.bind_all("<MouseWheel>", _smart_mousewheel)

        # 체크박스 변수 목록
        self.playlist_check_vars = []
        self.playlist_check_widgets = []

        # 기본 숨김
        self._hide_playlist_section()

        # ── 진행 상황 섹션 ──
        progress_section = self._make_section(main_frame, "진행 상황", 11)
        progress_inner = ctk.CTkFrame(progress_section, fg_color="transparent")
        progress_inner.grid(row=0, column=0, sticky="ew", padx=10, pady=10)
        progress_inner.columnconfigure(0, weight=1)

        self.progress_bar = ctk.CTkProgressBar(progress_inner, height=14, corner_radius=7,
                                               fg_color=self.PROGRESS_BG,
                                               progress_color=self.PROGRESS_FG)
        self.progress_bar.set(0)
        self.progress_bar.grid(row=0, column=0, sticky="ew", pady=(0, 6))

        self.status_label = ctk.CTkLabel(progress_inner, text="⏳ 대기 중",
                                         font=ctk.CTkFont(size=12),
                                         text_color=self.TEXT_SECONDARY, anchor="w")
        self.status_label.grid(row=1, column=0, sticky="w")

        self.detail_label = ctk.CTkLabel(progress_inner, text="",
                                         font=ctk.CTkFont(size=11),
                                         text_color=self.ACCENT, anchor="w")
        self.detail_label.grid(row=2, column=0, sticky="w")

        self.file_label = ctk.CTkLabel(progress_inner, text="",
                                       font=ctk.CTkFont(size=11),
                                       text_color=self.TEXT_SECONDARY, anchor="w",
                                       wraplength=600)
        self.file_label.grid(row=3, column=0, sticky="w")

        # ── 다운로드 버튼 (맨 아래) ──
        self.download_btn = ctk.CTkButton(main_frame, text="다운로드", height=42,
                                          corner_radius=10, fg_color=self.ACCENT,
                                          hover_color=self.ACCENT_HOVER,
                                          font=ctk.CTkFont(size=14, weight="bold"),
                                          command=self.start_download, state="disabled")
        self.download_btn.grid(row=14, column=0, sticky="ew", pady=(6, 4))
    
    def _select_all_playlist(self):
        """플레이리스트 전체 선택"""
        for var in self.playlist_check_vars:
            var.set(True)
        self._update_playlist_select_label()

    def _deselect_all_playlist(self):
        """플레이리스트 선택 해제"""
        for var in self.playlist_check_vars:
            var.set(False)
        self._update_playlist_select_label()

    def _on_playlist_select(self, event=None):
        """플레이리스트 선택 변경 시 레이블 업데이트"""
        self._update_playlist_select_label()

    def _update_playlist_select_label(self):
        """선택 수 레이블 갱신"""
        selected = sum(1 for v in self.playlist_check_vars if v.get())
        total = len(self.playlist_check_vars)
        self.pl_select_label.configure(text=f"{selected}/{total} 선택됨")

    def _get_selected_playlist_indices(self):
        """체크된 항목의 인덱스 리스트 반환"""
        return [i for i, v in enumerate(self.playlist_check_vars) if v.get()]

    def _on_type_change(self):
        """다운로드 타입 변경 시 처리"""
        self.update_format_list()

    def _adjust_thread(self, delta):
        """스레드 수 증가/감소"""
        try:
            current = int(self.thread_entry.get())
        except ValueError:
            current = 4
        new_val = max(1, min(12, current + delta))
        self.thread_entry.delete(0, tk.END)
        self.thread_entry.insert(0, str(new_val))

    def _show_playlist_section(self):
        """플레이리스트 목록 섹션 표시"""
        self.playlist_section_label.grid(row=8, column=0, sticky="w", pady=(8, 2), padx=2)
        self.playlist_section_frame.grid(row=9, column=0, sticky="ew", pady=(0, 4))

    def _hide_playlist_section(self):
        """플레이리스트 목록 섹션 숨김"""
        self.playlist_section_label.grid_remove()
        self.playlist_section_frame.grid_remove()

    def update_thread_label(self, value):
        """스레드 개수 레이블 업데이트"""
        count = int(float(value))
        self.thread_label.config(text=f"{count}개")
        if count == 1:
            self.thread_label.config(text="1개 (단일)")
        elif count <= 4:
            self.thread_label.config(text=f"{count}개 (보통)")
        elif count <= 8:
            self.thread_label.config(text=f"{count}개 (빠름)")
        else:
            self.thread_label.config(text=f"{count}개 (매우 빠름)")
    
    @staticmethod
    def detect_url_type(url):
        """
        URL 타입 감지.
        Returns: (clean_url, is_playlist)
        - list= 파라미터 있음 (라디오 포함) → 플레이리스트
        - 그 외 → 단일 영상
        """
        parsed = urlparse(url)
        params = parse_qs(parsed.query)

        has_list = 'list' in params

        if has_list:
            # list 파라미터가 있으면 플레이리스트로 처리 (RD 라디오 포함)
            return url, True

        # 단일 영상
        clean_params = {}
        if 'v' in params:
            clean_params['v'] = params['v'][0]
        clean_query = urlencode(clean_params)
        return urlunparse(parsed._replace(query=clean_query)), False

    def fetch_video_info(self):
        url = self.url_entry.get().strip()
        if not url:
            messagebox.showwarning("경고", "YouTube URL을 입력해주세요.")
            return

        clean_url, is_playlist = self.detect_url_type(url)
        self.is_playlist = is_playlist
        self.playlist_entries = []

        self.status_label.configure(text="⏳ 영상 정보를 가져오는 중...")
        self.detail_label.configure(text="")
        self.file_label.configure(text="")
        self.progress_bar.configure(mode="indeterminate")
        self.progress_bar.start()
        self.fetch_btn.configure(state="disabled")
        self._hide_playlist_section()

        thread = threading.Thread(target=self._fetch_video_info_thread,
                                  args=(clean_url, is_playlist))
        thread.start()

    def _fetch_video_info_thread(self, url, is_playlist):
        try:
            if is_playlist:
                ydl_opts = {
                    'quiet': True,
                    'no_warnings': True,
                    'noplaylist': False,
                    'extract_flat': 'in_playlist',   # 빠른 목록만 추출
                    'no_check_certificates': True,
                    'geo_bypass': True,
                }
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    info = ydl.extract_info(url, download=False)

                entries = list(info.get('entries', []))
                # 다운로드 불가 항목 필터링 (Private, Deleted 등)
                _skip = {'[private video]', '[deleted video]', '[unavailable video]'}
                entries = [e for e in entries if e and
                           e.get('title', '').strip().lower() not in _skip and
                           e.get('id') is not None]
                self.playlist_entries = entries
                self.video_info = info  # 플레이리스트 메타로 저장

                # 플레이리스트 첫 번째 영상의 포맷 정보를 가져오기 위해 단일 영상 정보 추출
                if entries:
                    first_url = entries[0].get('url') or entries[0].get('id')
                    if first_url and not first_url.startswith('http'):
                        first_url = f"https://www.youtube.com/watch?v={first_url}"
                    single_opts = {
                        'quiet': True, 'no_warnings': True,
                        'noplaylist': True,
                        'no_check_certificates': True, 'geo_bypass': True,
                    }
                    with yt_dlp.YoutubeDL(single_opts) as ydl2:
                        first_info = ydl2.extract_info(first_url, download=False)
                    self.video_info_single = first_info
                else:
                    self.video_info_single = None

                self.root.after(0, self.display_playlist_info)
            else:
                ydl_opts = {
                    'quiet': True,
                    'no_warnings': True,
                    'noplaylist': True,
                    'no_check_certificates': True,
                    'geo_bypass': True,
                }
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    self.video_info = ydl.extract_info(url, download=False)
                self.video_info_single = self.video_info
                self.root.after(0, self.display_video_info)
        except Exception as e:
            self.root.after(0, lambda: self.show_error(f"오류 발생: {str(e)}"))
    
    def display_video_info(self):
        if not self.video_info:
            return

        info_text = f"제목: {self.video_info['title']}\n"
        duration = self.video_info.get('duration', 0) or 0
        info_text += f"길이: {duration // 60}분 {duration % 60}초\n"
        info_text += f"업로더: {self.video_info.get('uploader', 'N/A')}\n"
        view_count = self.video_info.get('view_count')
        info_text += f"조회수: {view_count:,}" if isinstance(view_count, int) else "조회수: N/A"

        self.info_text.configure(state="normal")
        self.info_text.delete("1.0", "end")
        self.info_text.insert("1.0", info_text)
        self.info_text.configure(state="disabled")

        self.extract_formats()
        self.update_format_list()
        self._finish_fetch()

    def display_playlist_info(self):
        """플레이리스트 정보를 표시"""
        info = self.video_info
        if not info:
            return

        count = len(self.playlist_entries)
        info_text = f"플레이리스트: {info.get('title', 'N/A')}\n"
        info_text += f"채널: {info.get('uploader', info.get('channel', 'N/A'))}\n"
        info_text += f"영상 수: {count}개"

        self.info_text.configure(state="normal")
        self.info_text.delete("1.0", "end")
        self.info_text.insert("1.0", info_text)
        self.info_text.configure(state="disabled")

        # 포맷은 첫 번째 영상 기준
        if self.video_info_single:
            self.video_info_for_format = self.video_info_single
            self.extract_formats(source=self.video_info_single)
            self.update_format_list()

        # 플레이리스트 목록 표시
        self._show_playlist_section()
        # 기존 체크박스 제거
        for w in self.playlist_check_widgets:
            w.destroy()
        self.playlist_check_vars.clear()
        self.playlist_check_widgets.clear()

        for i, entry in enumerate(self.playlist_entries):
            title = entry.get('title', entry.get('id', '알 수 없음'))
            var = ctk.BooleanVar(value=True)
            cb = ctk.CTkCheckBox(
                self.playlist_scroll_frame,
                text=f"⏳  {i+1:>3}.  {title}",
                variable=var,
                font=ctk.CTkFont(family="Consolas", size=11),
                text_color=self.TEXT_SECONDARY,
                fg_color=self.ACCENT,
                hover_color=self.ACCENT_HOVER,
                border_color=self.ENTRY_BG,
                checkmark_color="#ffffff",
                corner_radius=4,
                command=self._on_playlist_select
            )
            cb.grid(row=i, column=0, sticky="w", padx=6, pady=1)
            self.playlist_check_vars.append(var)
            self.playlist_check_widgets.append(cb)

        # 기본: 전체 선택 (이미 True로 초기화)
        self._update_playlist_select_label()

        self._finish_fetch()

    def _finish_fetch(self):
        """정보 가져오기 완료 공통 처리"""
        self.progress_bar.stop()
        self.progress_bar.configure(mode="determinate")
        self.progress_bar.set(0)
        label = "✅ 플레이리스트 정보를 가져왔습니다." if self.is_playlist else "✅ 영상 정보를 가져왔습니다."
        self.status_label.configure(text=label)
        self.file_label.configure(text="")
        self.fetch_btn.configure(state="normal")
        self.download_btn.configure(state="normal")
    
    def extract_formats(self, source=None):
        self.video_formats = []
        self.audio_formats = []
        info = source or self.video_info
        if not info or 'formats' not in info:
            return
        for f in info['formats']:
            if f.get('vcodec') != 'none' and f.get('height'):
                format_info = {
                    'format_id': f['format_id'],
                    'ext': f['ext'],
                    'resolution': f.get('height'),
                    'fps': f.get('fps', 'N/A'),
                    'filesize': f.get('filesize'),
                    'has_audio': f.get('acodec') != 'none',
                    'vcodec': f.get('vcodec', ''),
                    'acodec': f.get('acodec', 'none')
                }
                self.video_formats.append(format_info)
            
            elif f.get('acodec') != 'none' and f.get('vcodec') == 'none':
                format_info = {
                    'format_id': f['format_id'],
                    'ext': f['ext'],
                    'abr': f.get('abr', 'N/A'),
                    'acodec': f.get('acodec', ''),
                    'filesize': f.get('filesize')
                }
                self.audio_formats.append(format_info)
        
        seen = {}
        for f in self.video_formats:
            res = f['resolution']
            if res not in seen or (f['has_audio'] and not seen[res]['has_audio']):
                seen[res] = f
        
        self.video_formats = sorted(seen.values(), key=lambda x: x['resolution'], reverse=True)
        
        self.audio_formats = sorted(
            [f for f in self.audio_formats if isinstance(f.get('abr'), (int, float))],
            key=lambda x: x.get('abr', 0),
            reverse=True
        )[:5]
    
    def update_format_list(self):
        self.format_listbox.delete(0, tk.END)
        self.displayed_video_formats = []

        if self.download_type.get() == "video":
            if self.is_playlist:
                # 플레이리스트: 표준 해상도 프리셋 표시
                presets = [2160, 1440, 1080, 720, 480, 360, 240, 144]
                for res in presets:
                    text = f"{res:4}p | 미지원 시 최고 화질로 대체"
                    self.format_listbox.insert(tk.END, text)
                    self.displayed_video_formats.append({
                        'resolution': res, 'has_audio': True,
                        'format_id': None, 'ext': 'mp4', 'preset': True
                    })
            else:
                # 단일 영상: 실제 포맷 표시
                for fmt in self.video_formats:
                    size_str = self.format_filesize(fmt['filesize'])
                    text = f"{fmt['resolution']:4}p | {fmt['ext']:4} | {size_str}"
                    self.format_listbox.insert(tk.END, text)
                    self.displayed_video_formats.append(fmt)
        else:
            if self.audio_formats:
                for fmt in self.audio_formats:
                    abr = fmt.get('abr', 'N/A')
                    size_str = self.format_filesize(fmt['filesize'])
                    acodec = fmt.get('acodec', '?')
                    codec_short = acodec.split('.')[0] if '.' in acodec else acodec
                    abr_str = f"{abr}kbps" if isinstance(abr, (int, float)) else str(abr)
                    text = f"MP3 | {abr_str:>10} | {codec_short:>5} | {size_str}"
                    self.format_listbox.insert(tk.END, text)
            else:
                self.format_listbox.insert(tk.END, "최고 품질 오디오 (MP3 변환)")

        # 리스트박스 높이를 항목 수에 맞춰 동적 조절 (min 1, max 10)
        count = self.format_listbox.size()
        new_height = max(1, min(10, count))
        self.format_listbox.configure(height=new_height)
    
    def format_filesize(self, size):
        if size is None or size == 0:
            return "크기 정보 없음"
        
        for unit in ['B', 'KB', 'MB', 'GB']:
            if size < 1024.0:
                return f"{size:6.1f} {unit}"
            size /= 1024.0
        return f"{size:6.1f} TB"
    
    def browse_folder(self):
        folder = filedialog.askdirectory(initialdir=self.download_path)
        if folder:
            self.download_path = folder
            self.path_entry.delete(0, tk.END)
            self.path_entry.insert(0, folder)
    
    def start_download(self):
        if not self.video_info:
            messagebox.showwarning("경고", "먼저 영상 정보를 가져와주세요.")
            return
        
        download_path = self.path_entry.get().strip()
        if not download_path:
            messagebox.showwarning("경고", "저장 경로를 선택해주세요.")
            return
        
        download_type = self.download_type.get()
        
        if download_type == "video":
            selection = self.format_listbox.curselection()
            if not selection:
                messagebox.showwarning("경고", "다운로드할 해상도를 선택해주세요.")
                return
            format_idx = selection[0]
            if format_idx >= len(self.displayed_video_formats):
                messagebox.showwarning("경고", "유효한 포맷을 선택해주세요.")
                return
            selected_format = self.displayed_video_formats[format_idx]
        else:
            selection = self.format_listbox.curselection()
            if self.audio_formats and selection:
                format_idx = selection[0]
                selected_format = self.audio_formats[format_idx]
            else:
                selected_format = None
        
        self.status_label.configure(text="⏳ 다운로드 준비 중...")
        self.detail_label.configure(text="")
        self.file_label.configure(text="")
        self.progress_bar.set(0)
        self.download_btn.configure(state="disabled")

        if self.is_playlist and self.playlist_entries:
            # 선택된 항목만 다운로드
            selected_indices = self._get_selected_playlist_indices()
            if not selected_indices:
                messagebox.showwarning("경고", "다운로드할 플레이리스트 항목을 선택해주세요.")
                self.download_btn.configure(state="normal")
                return
            selected_entries = [self.playlist_entries[i] for i in selected_indices]
            thread = threading.Thread(target=self._download_playlist_thread,
                                     args=(selected_format, download_path, download_type,
                                           selected_entries, list(selected_indices)))
        else:
            thread = threading.Thread(target=self._download_thread,
                                     args=(self.url_entry.get(), selected_format,
                                          download_path, download_type))
        thread.start()
    
    # def progress_hook(self, d):
    #     if d['status'] == 'downloading':
    #         if 'total_bytes' in d:
    #             total = d['total_bytes']
    #             downloaded = d['downloaded_bytes']
    #             percent = (downloaded / total) * 100
    #         elif 'total_bytes_estimate' in d:
    #             total = d['total_bytes_estimate']
    #             downloaded = d['downloaded_bytes']
    #             percent = (downloaded / total) * 100
    #         else:
    #             percent = 0
            
    #         speed = d.get('speed', 0)
    #         eta = d.get('eta', 0)
            
    #         speed_str = self.format_speed(speed)
    #         eta_str = self.format_time(eta)
            
    #         self.root.after(0, self.update_progress, percent, speed_str, eta_str)
        
    #     elif d['status'] == 'finished':
    #         self.root.after(0, self.update_progress, 100, "완료", "0초")

    def progress_hook(self, d):
        """다운로드 진행 상황을 GUI에 최적화하여 반영하는 콜백"""

        if d['status'] == 'downloading':
            downloaded = d.get('downloaded_bytes', 0)

            # total_bytes 또는 total_bytes_estimate
            total = d.get('total_bytes') or d.get('total_bytes_estimate')
            if not total or total == 0:
                percent = 0
            else:
                percent = (downloaded / total) * 100

            # 🔥 10% 단위 제한
            rounded = int(percent // 5) * 5
            if rounded > 100:
                rounded = 100

            # 🔥 이전과 동일한 진행률이면 업데이트하지 않음 → 성능 최적화
            if getattr(self, "last_progress", -1) == rounded:
                return

            self.last_progress = rounded  # 캐싱

            speed_str = self.format_speed(d.get('speed'))
            eta_str = self.format_time(d.get('eta'))

            # 파일명 추출
            filename = os.path.basename(d.get('filename', ''))

            # 🔥 최소한의 UI 업데이트
            self.root.after(0, self.update_progress, rounded, speed_str, eta_str, filename)

        elif d['status'] == 'finished':
            self.last_progress = 100
            filename = os.path.basename(d.get('filename', ''))
            self.root.after(0, self.update_progress, 100, "완료", "0초", filename)

    
    def format_speed(self, speed):
        if speed is None or speed == 0:
            return "계산 중..."
        
        if speed < 1024:
            return f"{speed:.1f} B/s"
        elif speed < 1024 * 1024:
            return f"{speed/1024:.1f} KB/s"
        else:
            return f"{speed/(1024*1024):.1f} MB/s"
    
    def format_time(self, seconds):
        if seconds is None or seconds == 0:
            return "계산 중..."
        
        if seconds < 60:
            return f"{int(seconds)}초"
        elif seconds < 3600:
            return f"{int(seconds//60)}분 {int(seconds%60)}초"
        else:
            return f"{int(seconds//3600)}시간 {int((seconds%3600)//60)}분"
    
    def update_progress(self, percent, speed, eta, filename=""):
        self.progress_bar.set(percent / 100)
        if percent >= 100:
            self.status_label.configure(text="✅ 다운로드 완료!")
        else:
            self.status_label.configure(text=f"⬇ 다운로드 중... {percent:.1f}%")
        self.detail_label.configure(text=f"속도: {speed} | 남은 시간: {eta}")
        if filename:
            self.file_label.configure(text=f"📁 {filename}")
    
    def _download_thread(self, url, selected_format, download_path, download_type):
        try:
            Path(download_path).mkdir(parents=True, exist_ok=True)
            
            # 멀티스레드 개수 가져오기
            thread_count = self.thread_count.get()
            
            if download_type == 'video':
                format_id = selected_format['format_id']
                resolution = selected_format['resolution']
                
                # 오디오가 포함된 포맷이면 그대로 다운로드
                if selected_format['has_audio']:
                    ydl_opts = {
                        'format': format_id,
                        'outtmpl': os.path.join(download_path, f'%(title)s.{resolution}p.%(ext)s'),
                        'concurrent_fragment_downloads': thread_count,  # 멀티스레드 설정
                        'progress_hooks': [self.progress_hook],
                    }
                else:
                    # 오디오가 없으면 별도 다운로드 후 병합
                    ydl_opts = {
                        'format': f'{format_id}+bestaudio[ext=m4a]/{format_id}+bestaudio/{format_id}',
                        'outtmpl': os.path.join(download_path, f'%(title)s.{resolution}p.%(ext)s'),
                        'merge_output_format': 'mp4',
                        'keepvideo': False,
                        'concurrent_fragment_downloads': thread_count,  # 멀티스레드 설정
                        'postprocessors': [{
                            'key': 'FFmpegVideoRemuxer',
                            'preferedformat': 'mp4',
                        }],
                        'progress_hooks': [self.progress_hook],
                    }
            else:
                # 오디오 다운로드
                if selected_format:
                    format_id = selected_format['format_id']
                    abr = selected_format.get('abr', '')
                    
                    if abr and isinstance(abr, (int, float)):
                        filename_template = f'%(title)s.{int(abr)}kbps.%(ext)s'
                    else:
                        filename_template = '%(title)s.%(ext)s'
                    
                    ydl_opts = {
                        'format': format_id,
                        'outtmpl': os.path.join(download_path, filename_template),
                        'concurrent_fragment_downloads': thread_count,  # 멀티스레드 설정
                        'postprocessors': [{
                            'key': 'FFmpegExtractAudio',
                            'preferredcodec': 'mp3',
                            'preferredquality': '192',
                        }],
                        'progress_hooks': [self.progress_hook],
                    }
                else:
                    ydl_opts = {
                        'format': 'bestaudio/best',
                        'outtmpl': os.path.join(download_path, '%(title)s.%(ext)s'),
                        'concurrent_fragment_downloads': thread_count,  # 멀티스레드 설정
                        'postprocessors': [{
                            'key': 'FFmpegExtractAudio',
                            'preferredcodec': 'mp3',
                            'preferredquality': '192',
                        }],
                        'progress_hooks': [self.progress_hook],
                    }
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([url])
            
            # 임시 파일 정리
            self.cleanup_temp_files(download_path)
            
            self.root.after(0, self.download_complete, download_path)
        except Exception as e:
            self.root.after(0, lambda: self.show_error(f"다운로드 오류: {str(e)}"))
    
    def _download_playlist_thread(self, selected_format, download_path, download_type,
                                    entries=None, indices=None):
        """플레이리스트 선택 항목을 순차 다운로드"""
        try:
            Path(download_path).mkdir(parents=True, exist_ok=True)
            if entries is None:
                entries = self.playlist_entries
                indices = list(range(len(entries)))
            total = len(entries)

            try:
                thread_count = int(self.thread_entry.get())
                thread_count = max(1, min(12, thread_count))
            except ValueError:
                thread_count = 4

            for dl_idx, (entry, listbox_idx) in enumerate(zip(entries, indices)):
                video_id = entry.get('url') or entry.get('id')
                if video_id and not video_id.startswith('http'):
                    video_url = f"https://www.youtube.com/watch?v={video_id}"
                else:
                    video_url = video_id

                title = entry.get('title', video_id or f'영상 {dl_idx+1}')

                # UI 업데이트: 현재 다운로드 중 표시
                self.root.after(0, self._update_playlist_item_status, listbox_idx, "downloading", title)
                self.root.after(0, self.status_label.configure,
                                {"text": f"⬇ [{dl_idx+1}/{total}] {title}"})
                self.root.after(0, self.file_label.configure,
                                {"text": f"📁 {title}"})
                self.root.after(0, self.progress_bar.set, 0)
                self.last_progress = -1

                # 개별 영상 정보 가져오기
                try:
                    info_opts = {
                        'quiet': True, 'no_warnings': True,
                        'noplaylist': True,
                        'no_check_certificates': True, 'geo_bypass': True,
                    }
                    with yt_dlp.YoutubeDL(info_opts) as ydl:
                        single_info = ydl.extract_info(video_url, download=False)
                except Exception:
                    self.root.after(0, self._update_playlist_item_status, listbox_idx, "error", title)
                    continue

                # 다운로드 옵션 구성
                ydl_opts = self._build_download_opts(
                    single_info, selected_format, download_path,
                    download_type, thread_count
                )

                try:
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        ydl.download([video_url])
                    self.root.after(0, self._update_playlist_item_status, listbox_idx, "done", title)
                except Exception:
                    self.root.after(0, self._update_playlist_item_status, listbox_idx, "error", title)

            self.cleanup_temp_files(download_path)
            self.root.after(0, self._playlist_download_complete, download_path, total)
        except Exception as e:
            self.root.after(0, lambda: self.show_error(f"플레이리스트 다운로드 오류: {str(e)}"))

    def _build_download_opts(self, single_info, selected_format, download_path,
                             download_type, thread_count):
        """단일 영상 다운로드 옵션 구성 (플레이리스트 개별 항목용)"""
        if download_type == 'video':
            # 선택 해상도와 가장 가까운 포맷 찾기
            target_res = selected_format['resolution'] if selected_format else 720
            best_fmt = None
            for f in single_info.get('formats', []):
                if f.get('vcodec') == 'none' or not f.get('height'):
                    continue
                if best_fmt is None or abs(f['height'] - target_res) < abs(best_fmt['height'] - target_res):
                    best_fmt = f

            if best_fmt:
                fmt_id = best_fmt['format_id']
                res = best_fmt.get('height', target_res)
                has_audio = best_fmt.get('acodec', 'none') != 'none'
            else:
                fmt_id = 'best'
                res = target_res
                has_audio = True

            if has_audio:
                return {
                    'format': fmt_id,
                    'outtmpl': os.path.join(download_path, f'%(title)s.{res}p.%(ext)s'),
                    'concurrent_fragment_downloads': thread_count,
                    'progress_hooks': [self.progress_hook],
                    'noplaylist': True,
                }
            else:
                return {
                    'format': f'{fmt_id}+bestaudio[ext=m4a]/{fmt_id}+bestaudio/{fmt_id}',
                    'outtmpl': os.path.join(download_path, f'%(title)s.{res}p.%(ext)s'),
                    'merge_output_format': 'mp4',
                    'keepvideo': False,
                    'concurrent_fragment_downloads': thread_count,
                    'postprocessors': [{'key': 'FFmpegVideoRemuxer', 'preferedformat': 'mp4'}],
                    'progress_hooks': [self.progress_hook],
                    'noplaylist': True,
                }
        else:
            return {
                'format': 'bestaudio/best',
                'outtmpl': os.path.join(download_path, '%(title)s.%(ext)s'),
                'concurrent_fragment_downloads': thread_count,
                'postprocessors': [{
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'mp3',
                    'preferredquality': '192',
                }],
                'progress_hooks': [self.progress_hook],
                'noplaylist': True,
            }

    def _update_playlist_item_status(self, idx, status, title):
        """플레이리스트 체크박스의 특정 항목 상태 업데이트"""
        if status == "downloading":
            icon = "⬇"
            color = self.ACCENT
        elif status == "done":
            icon = "✅"
            color = "#22c55e"
        elif status == "error":
            icon = "❌"
            color = "#ef4444"
        else:
            icon = "⏳"
            color = self.TEXT_SECONDARY

        if idx < len(self.playlist_check_widgets):
            cb = self.playlist_check_widgets[idx]
            cb.configure(text=f"{icon}  {idx+1:>3}.  {title}", text_color=color)

    def _playlist_download_complete(self, path, total):
        """플레이리스트 전체 다운로드 완료"""
        self.progress_bar.set(1.0)
        self.status_label.configure(text=f"✅ 플레이리스트 {total}개 다운로드 완료!")
        self.detail_label.configure(text="모든 파일이 성공적으로 저장되었습니다.")
        self.file_label.configure(text="")
        self.download_btn.configure(state="normal")
        messagebox.showinfo("완료", f"플레이리스트 {total}개 다운로드 완료!\n저장 위치: {path}")

    def cleanup_temp_files(self, directory):
        """임시 파일(.temp, .part 등) 삭제"""
        try:
            for file in Path(directory).glob('*'):
                if file.suffix in ['.temp', '.part', '.ytdl']:
                    file.unlink()
        except:
            pass
    
    def download_complete(self, path):
        self.progress_bar.set(1.0)
        self.status_label.configure(text="✅ 다운로드 완료!")
        self.detail_label.configure(text="파일이 성공적으로 저장되었습니다.")
        self.download_btn.configure(state="normal")
        # 완료된 파일명 찾아서 표시
        title = self.video_info.get('title', '') if self.video_info else ''
        if title:
            self.file_label.configure(text=f"📁 {title}")
        messagebox.showinfo("완료", f"다운로드가 완료되었습니다!\n저장 위치: {path}")
    
    def show_error(self, message):
        self.progress_bar.set(0)
        self.status_label.configure(text="❌ 오류 발생")
        self.detail_label.configure(text="")
        self.file_label.configure(text="")
        self.fetch_btn.configure(state="normal")
        self.download_btn.configure(state="normal")
        messagebox.showerror("오류", message)

def main():
    root = ctk.CTk()
    app = YouTubeDownloaderGUI(root)
    root.mainloop()

if __name__ == "__main__":
    main()






    # 중단 기능 추가
    # 실행 시 터미널에 뜨는 메시지를 캡처하여 GUI에 표시하는 기능 추가(퍼센티지 포함) - 텍스트 박스
    # 진행상황 초록색 바 삭제
    # 저장 시 파일 이름 지정할 수 있도록 
    # 품질/해상도 선택 시 모든 옵션에서 크기 정보 없음 - 크기정보 확인 안되면 표시하지 않기
    # 전체 ui 크기 최적화(현재 오른쪽 여백 많음)
    # 동일 파일명 존재 시 덮어쓰기 여부 묻기
    # 다운로드 중지 / 이어받기/완전 중지 추가 / 완전 중지 시 part 파일 삭제 - 이어받기 기능을 위해 체크포인트같은 설정이 필요한지
    # 