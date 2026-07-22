"use client";

/**
 * File: src/dashboard-layout.tsx
 * Area: Draggable/minimizable/hideable window shell
 * Purpose: Compose draggable panels, comms feed, keyboard controls, and UI audio cues.
 * Origin: Extracted from Heliospheric's dashboard-layout.tsx. Behavior is unchanged
 *         from the original; only storage keys and custom event names are namespaced
 *         for this package so multiple consumers can coexist on the same page.
 */

import { GripVertical } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

export type NotificationEvent = {
  id: string;
  text: string;
  tone: "info" | "success" | "error";
  timestamp: string;
};

export type DashboardLayoutProps = {
  leftPanel: ReactNode;
  rightPanel: ReactNode;
  mainPanel: ReactNode;
  notifications?: NotificationEvent[];
};

type Position = {
  x: number;
  y: number;
};

type DragTarget = "left" | "right" | "chat" | "audio";

type ConfigTab = "audio" | "comms" | "interaction" | "display";

type SoundCue = "toggle" | "close" | "dragStart" | "drop" | "focus" | "info" | "success" | "error";

const CHAT_FADE_MS = 15000;
const CHAT_FADE_OUT_MS = 3000;
const CONFIG_STORAGE_KEY = "helioverse:dashboard:config:v1";
const LAYOUT_STORAGE_KEY = "helioverse:dashboard:layout:v1";
export const FOCUS_EVENT = "helioverse:focus-target";

const INERTIA_BY_PANEL: Record<DragTarget, { durationMs: number; easingPower: number }> = {
  left: { durationMs: 135, easingPower: 2.4 },
  right: { durationMs: 175, easingPower: 3.1 },
  chat: { durationMs: 105, easingPower: 2.1 },
  audio: { durationMs: 125, easingPower: 2.3 },
};

const DEFAULT_CONFIG = {
  muted: false,
  masterVolume: 72,
  uiVolume: 58,
  cueIntensity: 100,
  chatFadeMs: CHAT_FADE_MS,
  typewriterIntervalMs: 18,
  maxChatMessages: 8,
  autoOpenComms: true,
  inertiaScale: 1,
  snapRadius: 28,
  showHotkeyHints: true,
  backgroundAtmosphere: 100,
};

function getStoredConfig(): Partial<typeof DEFAULT_CONFIG> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(CONFIG_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    return JSON.parse(raw) as Partial<typeof DEFAULT_CONFIG>;
  } catch {
    return {};
  }
}

type StoredLayout = {
  leftVisible: boolean;
  rightVisible: boolean;
  chatVisible: boolean;
  audioVisible: boolean;
  leftMinimized: boolean;
  rightMinimized: boolean;
  chatMinimized: boolean;
  audioMinimized: boolean;
  leftPos: Position;
  rightPos: Position;
  chatPos: Position;
  audioPos: Position;
};

function getStoredLayout(): Partial<StoredLayout> {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) {
      return {};
    }

    return JSON.parse(raw) as Partial<StoredLayout>;
  } catch {
    return {};
  }
}

function validPosition(value: unknown): value is Position {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as { x?: unknown; y?: unknown };
  return typeof candidate.x === "number" && Number.isFinite(candidate.x) && typeof candidate.y === "number" && Number.isFinite(candidate.y);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function DashboardLayout({
  leftPanel,
  rightPanel,
  mainPanel,
  notifications = [],
}: DashboardLayoutProps) {
  const storedConfig = getStoredConfig();
  const storedLayout = getStoredLayout();

  const [leftVisible, setLeftVisible] = useState(false);
  const [rightVisible, setRightVisible] = useState(false);
  const [chatVisible, setChatVisible] = useState(false);
  const [audioVisible, setAudioVisible] = useState(false);

  const [leftMinimized, setLeftMinimized] = useState(() => typeof storedLayout.leftMinimized === "boolean" ? storedLayout.leftMinimized : false);
  const [rightMinimized, setRightMinimized] = useState(() => typeof storedLayout.rightMinimized === "boolean" ? storedLayout.rightMinimized : false);
  const [chatMinimized, setChatMinimized] = useState(() => typeof storedLayout.chatMinimized === "boolean" ? storedLayout.chatMinimized : false);
  const [audioMinimized, setAudioMinimized] = useState(() => typeof storedLayout.audioMinimized === "boolean" ? storedLayout.audioMinimized : true);

  const [leftPos, setLeftPos] = useState<Position>(() => validPosition(storedLayout.leftPos) ? storedLayout.leftPos : { x: 74, y: 20 });
  const [rightPos, setRightPos] = useState<Position>(() => validPosition(storedLayout.rightPos) ? storedLayout.rightPos : { x: 0, y: 20 });
  const [chatPos, setChatPos] = useState<Position>(() => validPosition(storedLayout.chatPos) ? storedLayout.chatPos : { x: 0, y: 0 });
  const [audioPos, setAudioPos] = useState<Position>(() => validPosition(storedLayout.audioPos) ? storedLayout.audioPos : { x: 0, y: 0 });

  const [muted, setMuted] = useState(() => typeof storedConfig.muted === "boolean" ? storedConfig.muted : DEFAULT_CONFIG.muted);
  const [masterVolume, setMasterVolume] = useState(() => typeof storedConfig.masterVolume === "number" ? clamp(storedConfig.masterVolume, 0, 100) : DEFAULT_CONFIG.masterVolume);
  const [uiVolume, setUiVolume] = useState(() => typeof storedConfig.uiVolume === "number" ? clamp(storedConfig.uiVolume, 0, 100) : DEFAULT_CONFIG.uiVolume);
  const [cueIntensity, setCueIntensity] = useState(() => typeof storedConfig.cueIntensity === "number" ? clamp(storedConfig.cueIntensity, 0, 140) : DEFAULT_CONFIG.cueIntensity);
  const [chatFadeMs, setChatFadeMs] = useState(() => typeof storedConfig.chatFadeMs === "number" ? clamp(storedConfig.chatFadeMs, 6000, 60000) : DEFAULT_CONFIG.chatFadeMs);
  const [typewriterIntervalMs, setTypewriterIntervalMs] = useState(() => typeof storedConfig.typewriterIntervalMs === "number" ? clamp(storedConfig.typewriterIntervalMs, 8, 64) : DEFAULT_CONFIG.typewriterIntervalMs);
  const [maxChatMessages, setMaxChatMessages] = useState(() => typeof storedConfig.maxChatMessages === "number" ? clamp(Math.round(storedConfig.maxChatMessages), 4, 24) : DEFAULT_CONFIG.maxChatMessages);
  const [autoOpenComms, setAutoOpenComms] = useState(() => typeof storedConfig.autoOpenComms === "boolean" ? storedConfig.autoOpenComms : DEFAULT_CONFIG.autoOpenComms);
  const [inertiaScale, setInertiaScale] = useState(() => typeof storedConfig.inertiaScale === "number" ? clamp(storedConfig.inertiaScale, 0.5, 1.8) : DEFAULT_CONFIG.inertiaScale);
  const [snapRadius, setSnapRadius] = useState(() => typeof storedConfig.snapRadius === "number" ? clamp(storedConfig.snapRadius, 12, 64) : DEFAULT_CONFIG.snapRadius);
  const [showHotkeyHints, setShowHotkeyHints] = useState(false);
  const [backgroundAtmosphere, setBackgroundAtmosphere] = useState(() => typeof storedConfig.backgroundAtmosphere === "number" ? clamp(storedConfig.backgroundAtmosphere, 40, 150) : DEFAULT_CONFIG.backgroundAtmosphere);
  const [configTab, setConfigTab] = useState<ConfigTab>("audio");

  const [chatHovered, setChatHovered] = useState(false);
  const [chatActivityAt, setChatActivityAt] = useState(() => Date.now());
  const [clock, setClock] = useState(() => Date.now());
  const [chatMessages, setChatMessages] = useState<NotificationEvent[]>([]);
  const [typedCount, setTypedCount] = useState(0);
  const [draggingTarget, setDraggingTarget] = useState<DragTarget | null>(null);

  const dragRef = useRef<{
    target: DragTarget;
    offsetX: number;
    offsetY: number;
  } | null>(null);
  const dragFrameRef = useRef<number | null>(null);
  const pendingDragRef = useRef<{ target: DragTarget; next: Position } | null>(null);
  const snapFrameRef = useRef<Record<DragTarget, number | null>>({
    left: null,
    right: null,
    chat: null,
    audio: null,
  });
  const seenNotificationIds = useRef<Set<string>>(new Set());
  const chatFeedRef = useRef<HTMLDivElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    const payload = {
      muted,
      masterVolume,
      uiVolume,
      cueIntensity,
      chatFadeMs,
      typewriterIntervalMs,
      maxChatMessages,
      autoOpenComms,
      inertiaScale,
      snapRadius,
      showHotkeyHints,
      backgroundAtmosphere,
    };

    window.localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(payload));
  }, [
    autoOpenComms,
    backgroundAtmosphere,
    chatFadeMs,
    cueIntensity,
    inertiaScale,
    masterVolume,
    maxChatMessages,
    muted,
    showHotkeyHints,
    snapRadius,
    typewriterIntervalMs,
    uiVolume,
  ]);

  useEffect(() => {
    const layoutPayload: StoredLayout = {
      leftVisible,
      rightVisible,
      chatVisible,
      audioVisible,
      leftMinimized,
      rightMinimized,
      chatMinimized,
      audioMinimized,
      leftPos,
      rightPos,
      chatPos,
      audioPos,
    };

    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layoutPayload));
  }, [
    audioMinimized,
    audioPos,
    audioVisible,
    chatMinimized,
    chatPos,
    chatVisible,
    leftMinimized,
    leftPos,
    leftVisible,
    rightMinimized,
    rightPos,
    rightVisible,
  ]);

  const applyDragPosition = useCallback((target: DragTarget, next: Position) => {
    if (target === "left") {
      setLeftPos(next);
    } else if (target === "right") {
      setRightPos(next);
    } else if (target === "chat") {
      setChatPos(next);
    } else {
      setAudioPos(next);
    }
  }, []);

  const stopSnapAnimation = useCallback((target: DragTarget) => {
    const frame = snapFrameRef.current[target];
    if (frame !== null) {
      window.cancelAnimationFrame(frame);
      snapFrameRef.current[target] = null;
    }
  }, []);

  const ensureAudioContext = useCallback(() => {
    const ctor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!ctor) {
      return null;
    }

    if (!audioContextRef.current) {
      audioContextRef.current = new ctor();
    }

    if (audioContextRef.current.state === "suspended") {
      void audioContextRef.current.resume();
    }

    return audioContextRef.current;
  }, []);

  const playCue = useCallback((cue: SoundCue, gainScalar = 1) => {
    if (muted) {
      return;
    }

    const context = ensureAudioContext();
    if (!context) {
      return;
    }

    const now = context.currentTime;
    const volume = clamp((masterVolume / 100) * (uiVolume / 100) * (cueIntensity / 100) * gainScalar, 0, 1);
    if (volume <= 0.002) {
      return;
    }

    // Single reusable synth envelope for all dashboard micro-cues.
    const emit = (
      startFreq: number,
      endFreq: number,
      duration: number,
      type: OscillatorType,
      peakGain: number,
      delay = 0,
    ) => {
      const startAt = now + delay;
      const safeEnd = Math.max(80, endFreq);
      const oscillator = context.createOscillator();
      const gainNode = context.createGain();

      oscillator.type = type;
      oscillator.frequency.setValueAtTime(Math.max(80, startFreq), startAt);
      oscillator.frequency.exponentialRampToValueAtTime(safeEnd, startAt + duration);

      gainNode.gain.setValueAtTime(0.0001, startAt);
      gainNode.gain.exponentialRampToValueAtTime(Math.max(0.0001, volume * peakGain), startAt + Math.min(0.02, duration * 0.35));
      gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

      oscillator.connect(gainNode);
      gainNode.connect(context.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + duration + 0.015);
    };

    if (cue === "toggle") {
      emit(420, 640, 0.055, "triangle", 0.23);
      return;
    }

    if (cue === "close") {
      emit(560, 300, 0.075, "square", 0.2);
      return;
    }

    if (cue === "dragStart") {
      emit(240, 280, 0.04, "sine", 0.14);
      return;
    }

    if (cue === "drop") {
      emit(300, 460, 0.06, "sine", 0.17);
      emit(460, 390, 0.055, "triangle", 0.14, 0.035);
      return;
    }

    if (cue === "focus") {
      emit(500, 740, 0.06, "triangle", 0.22);
      emit(740, 640, 0.055, "triangle", 0.2, 0.03);
      return;
    }

    if (cue === "success") {
      emit(460, 680, 0.06, "triangle", 0.21);
      emit(680, 920, 0.07, "triangle", 0.2, 0.045);
      return;
    }

    if (cue === "error") {
      emit(420, 260, 0.085, "sawtooth", 0.2);
      emit(260, 210, 0.08, "sawtooth", 0.18, 0.03);
      return;
    }

    emit(360, 430, 0.05, "triangle", 0.16);
  }, [cueIntensity, ensureAudioContext, masterVolume, muted, uiVolume]);

  const animateSnapToPosition = useCallback((target: DragTarget, from: Position, to: Position) => {
    stopSnapAnimation(target);

    const deltaX = Math.abs(from.x - to.x);
    const deltaY = Math.abs(from.y - to.y);
    if (deltaX < 0.6 && deltaY < 0.6) {
      applyDragPosition(target, to);
      return;
    }

    const start = performance.now();
    const profile = INERTIA_BY_PANEL[target];
    const duration = Math.round(profile.durationMs * inertiaScale);
    const easingPower = profile.easingPower;

    const step = (now: number) => {
      const progress = clamp((now - start) / duration, 0, 1);
      const eased = 1 - Math.pow(1 - progress, easingPower);

      applyDragPosition(target, {
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
      });

      if (progress < 1) {
        snapFrameRef.current[target] = window.requestAnimationFrame(step);
      } else {
        snapFrameRef.current[target] = null;
      }
    };

    snapFrameRef.current[target] = window.requestAnimationFrame(step);
  }, [applyDragPosition, inertiaScale, stopSnapAnimation]);

  const snapPosition = useCallback((target: DragTarget, position: Position): Position => {
    const margin = 24;
    const widthByTarget: Record<DragTarget, number> = {
      left: 384,
      right: 416,
      chat: 480,
      audio: 320,
    };

    const rightSnap = Math.max(margin, window.innerWidth - widthByTarget[target] - margin);
    const bottomSnap = Math.max(90, window.innerHeight - 300);
    const snapped = { ...position };

    if (Math.abs(position.x - margin) <= snapRadius) {
      snapped.x = margin;
    }
    if (Math.abs(position.x - rightSnap) <= snapRadius) {
      snapped.x = rightSnap;
    }
    if ((target === "chat" || target === "audio") && Math.abs(position.y - bottomSnap) <= snapRadius + 16) {
      snapped.y = bottomSnap;
    }

    return snapped;
  }, [snapRadius]);

  useEffect(() => {
    const placePanels = () => {
      const rightWidth = Math.min(420, window.innerWidth - 120);
      const chatWidth = Math.min(480, window.innerWidth - 120);
      setRightPos((previous) => ({ x: previous.x === 0 ? Math.max(84, window.innerWidth - rightWidth - 28) : previous.x, y: previous.y || 20 }));
      setChatPos((previous) => ({ x: previous.x === 0 ? Math.max(112, window.innerWidth - chatWidth - 34) : previous.x, y: previous.y === 0 ? Math.max(140, window.innerHeight - 320) : previous.y }));
      setAudioPos((previous) => ({ x: previous.x === 0 ? 112 : previous.x, y: previous.y === 0 ? Math.max(220, window.innerHeight - 250) : previous.y }));
    };

    placePanels();
    window.addEventListener("resize", placePanels);
    return () => window.removeEventListener("resize", placePanels);
  }, [animateSnapToPosition, applyDragPosition, stopSnapAnimation]);

  useEffect(() => {
    const merged = notifications.filter((item) => !seenNotificationIds.current.has(item.id));
    if (merged.length > 0) {
      merged.forEach((item) => seenNotificationIds.current.add(item.id));
      setChatMessages((current) => [...current, ...merged].slice(-maxChatMessages));
      const newest = merged[merged.length - 1];
      playCue(newest.tone);
      setChatActivityAt(Date.now());
      if (autoOpenComms) {
        setLeftVisible(false);
        setRightVisible(false);
        setAudioVisible(false);
        setChatVisible(true);
        setChatMinimized(false);
      }
      return;
    }

    if (notifications.length === 0 && chatMessages.length === 0) {
      const bootNotice: NotificationEvent = {
        id: "boot-notice",
        text: "Comms relay synchronized. Drag windows and shape your command deck.",
        tone: "info",
        timestamp: new Date().toISOString(),
      };
      seenNotificationIds.current.add(bootNotice.id);
      setChatMessages([bootNotice]);
    }
  }, [autoOpenComms, chatMessages.length, maxChatMessages, notifications, playCue]);

  useEffect(() => {
    return () => {
      const context = audioContextRef.current;
      if (context) {
        void context.close();
      }
      audioContextRef.current = null;
    };
  }, []);

  const latestMessage = chatMessages[chatMessages.length - 1];

  useEffect(() => {
    if (!latestMessage) {
      return;
    }

    let cancelled = false;
    let index = 0;

    const frame = window.requestAnimationFrame(() => {
      if (!cancelled) {
        setTypedCount(0);
      }
    });

    const interval = window.setInterval(() => {
      index += 1;
      if (index >= latestMessage.text.length) {
        setTypedCount(latestMessage.text.length);
        window.clearInterval(interval);
        return;
      }

      setTypedCount(index);
    }, typewriterIntervalMs);

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      window.clearInterval(interval);
    };
  }, [latestMessage, typewriterIntervalMs]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 300);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!chatVisible || chatMinimized) {
      return;
    }

    const feed = chatFeedRef.current;
    if (!feed) {
      return;
    }

    feed.scrollTop = feed.scrollHeight;
  }, [chatMessages, typedCount, chatVisible, chatMinimized]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (!dragRef.current) {
        return;
      }

      const maxX = Math.max(80, window.innerWidth - 360);
      const maxY = Math.max(40, window.innerHeight - 120);
      const next = {
        x: clamp(event.clientX - dragRef.current.offsetX, 62, maxX),
        y: clamp(event.clientY - dragRef.current.offsetY, 8, maxY),
      };

      pendingDragRef.current = {
        target: dragRef.current.target,
        next,
      };

      if (dragFrameRef.current === null) {
        dragFrameRef.current = window.requestAnimationFrame(() => {
          if (pendingDragRef.current) {
            applyDragPosition(pendingDragRef.current.target, pendingDragRef.current.next);
          }
          dragFrameRef.current = null;
        });
      }
    };

    const onPointerUp = () => {
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
        dragFrameRef.current = null;
      }

      if (pendingDragRef.current) {
        const from = pendingDragRef.current.next;
        const target = pendingDragRef.current.target;
        const snapped = snapPosition(target, from);
        animateSnapToPosition(target, from, snapped);
        playCue("drop", 0.75);
      }

      dragRef.current = null;
      pendingDragRef.current = null;
      setDraggingTarget(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      if (dragFrameRef.current !== null) {
        window.cancelAnimationFrame(dragFrameRef.current);
      }
      stopSnapAnimation("left");
      stopSnapAnimation("right");
      stopSnapAnimation("chat");
      stopSnapAnimation("audio");
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [animateSnapToPosition, applyDragPosition, playCue, snapPosition, stopSnapAnimation]);

  const beginDrag = (
    event: ReactPointerEvent<HTMLButtonElement>,
    target: DragTarget,
    position: Position,
  ) => {
    event.preventDefault();
    stopSnapAnimation(target);
    setDraggingTarget(target);
    dragRef.current = {
      target,
      offsetX: event.clientX - position.x,
      offsetY: event.clientY - position.y,
    };
    playCue("dragStart", 0.8);
  };

  function openExclusivePanel(target: DragTarget) {
    setLeftVisible(target === "left" ? (value) => !value : false);
    setRightVisible(target === "right" ? (value) => !value : false);
    setChatVisible(target === "chat" ? (value) => !value : false);
    setAudioVisible(target === "audio" ? (value) => !value : false);

    if (target === "left") {
      setLeftMinimized(false);
      return;
    }

    if (target === "right") {
      setRightMinimized(false);
      return;
    }

    if (target === "chat") {
      setChatMinimized(false);
      setChatActivityAt(Date.now());
      return;
    }

    setAudioMinimized(false);
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTypingTarget = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT" || target?.isContentEditable;

      if ((event.key === "h" || event.key === "H") && !event.metaKey && !event.ctrlKey && !event.altKey && !isTypingTarget) {
        event.preventDefault();
        setShowHotkeyHints((value) => !value);
        playCue("toggle", 0.7);
      }

      if (event.key === "[") {
        event.preventDefault();
        playCue("toggle", 0.75);
        openExclusivePanel("left");
      }

      if (event.key === "]") {
        event.preventDefault();
        playCue("toggle", 0.75);
        openExclusivePanel("right");
      }

      if (event.key === "\\") {
        event.preventDefault();
        playCue("toggle", 0.75);
        openExclusivePanel("chat");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [playCue]);

  useEffect(() => {
    const onDocumentClick = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      ) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const anchor = target?.closest("a[href]") as HTMLAnchorElement | null;
      if (!anchor) {
        return;
      }

      const href = anchor.getAttribute("href");
      if (!href) {
        return;
      }

      const currentUrl = new URL(window.location.href);
      const targetUrl = new URL(href, window.location.origin);
      if (targetUrl.origin !== currentUrl.origin || targetUrl.pathname !== currentUrl.pathname) {
        return;
      }

      const focusKey = targetUrl.searchParams.get("focus");
      if (!focusKey) {
        return;
      }

      event.preventDefault();

      const nextUrl = new URL(currentUrl.toString());
      nextUrl.searchParams.set("focus", focusKey);
      window.history.replaceState({}, "", `${nextUrl.pathname}?${nextUrl.searchParams.toString()}`);
      window.dispatchEvent(new CustomEvent(FOCUS_EVENT, { detail: { focusKey } }));
      playCue("focus", 0.9);

      setChatMessages((current) =>
        [
          ...current,
          {
            id: `focus-${Date.now()}`,
            text: `Focus lock: ${focusKey}`,
            tone: "info" as const,
            timestamp: new Date().toISOString(),
          },
        ].slice(-maxChatMessages),
      );
      setChatActivityAt(Date.now());
      setRightVisible(true);
      setRightMinimized(false);
    };

    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, [maxChatMessages, playCue]);

  const elapsed = clock - chatActivityAt;
  const chatVisibleHold = Math.max(1000, chatFadeMs - CHAT_FADE_OUT_MS);
  const chatOpacity = chatHovered ? 1 : elapsed <= chatVisibleHold ? 1 : clamp(1 - (elapsed - chatVisibleHold) / CHAT_FADE_OUT_MS, 0, 1);
  const chatDormant = !chatHovered && elapsed >= chatFadeMs;

  // configTab/backgroundAtmosphere/chatOpacity/chatDormant are retained from the
  // original component for behavioral parity (audio config + comms feed rendering
  // aren't wired up in this generic package yet -- HelioVerse consumers don't pass
  // audio/chat content, only leftPanel/rightPanel/mainPanel).

  const renderWindow = (
    target: DragTarget,
    title: string,
    position: Position,
    width: number,
    minimized: boolean,
    setMinimized: (value: boolean) => void,
    content: ReactNode,
  ) => (
    <div
      className="absolute z-[25] flex flex-col rounded-xl border border-slate-700/70 bg-slate-900/85 shadow-2xl backdrop-blur-md"
      style={{ left: position.x, top: position.y, width }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-2">
        <button
          type="button"
          onPointerDown={(event) => beginDrag(event, target, position)}
          className="flex flex-1 cursor-grab items-center gap-2 text-left text-xs uppercase tracking-[0.18em] text-slate-300 active:cursor-grabbing"
        >
          <GripVertical className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
          {title}
        </button>
        <button
          type="button"
          onClick={() => setMinimized(!minimized)}
          className="rounded px-1.5 py-0.5 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
          aria-label={minimized ? "Expand" : "Minimize"}
        >
          {minimized ? "▢" : "—"}
        </button>
      </div>
      {!minimized && <div className="max-h-[calc(100vh-88px)] overflow-y-auto p-4">{content}</div>}
    </div>
  );

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#010208]">
      <div className="absolute inset-0 z-10">
        {mainPanel}
        {renderWindow("left", "Mission Control", leftPos, 384, leftMinimized, setLeftMinimized, leftPanel)}
        {renderWindow("right", "Atlas", rightPos, 416, rightMinimized, setRightMinimized, rightPanel)}
      </div>
    </div>
  );
}

export default DashboardLayout;
