"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "@/lib/router";
import { AppShell } from "@/components/AppShell";
import { Button } from "@/components/Button";
import { CommunityScreenshotUploadButton } from "@/components/CommunityScreenshotUploadButton";
import { FormField } from "@/components/FormField";
import { Panel } from "@/components/Panel";
import { QuestionGuideButton } from "@/components/QuestionGuideButton";
import { createNewLocalPlayerSession, getLocalSession, saveLocalSession } from "@/lib/localSession";
import { createRoom, getRoomWithPlayers, joinRoom } from "@/lib/cloudflareRooms";
import { isRoomNicknameTaken } from "@/lib/roomNickname";
import { getInviteNicknameNotice, ROOM_REMOVAL_NOTICE } from "@/lib/roomEntryNotice";
import type { RoomVisibility } from "@/types/game";

const GITHUB_REPO_URL = "https://github.com/lpp12138/Anime-Master-Game-v2";
const INTRO_VIDEO_URL = "https://www.bilibili.com/video/BV1ZQug6SEKP/?share_source=copy_web&vd_source=adcd58a56c0c896937ee4c3fe22de339";
const FEEDBACK_QQ_GROUP_URL = "https://qm.qq.com/q/bHJQIRplmg";
const OTHER_GAME_URL = "https://decrypto.monight.dpdns.org/";
const FRIEND_LINKS = [
  { label: "二次元笑传之猜猜呗", href: "https://ccb.baka.website/" },
  { label: "BakaGame", href: "https://game.baka.website/" },
] as const;
const PLAYER_CAPACITY_FULL_ERROR_CODE = "PLAYER_CAPACITY_FULL";
const TEAM_SELECTION_REQUIRED_ERROR_CODE = "TEAM_SELECTION_REQUIRED";
const SHOW_MAINTENANCE_ANNOUNCEMENT = false;

function MaintenanceAnnouncement() {
  const [isOpen, setIsOpen] = useState(true);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
      if (event.key === "Tab") {
        event.preventDefault();
        document.getElementById("maintenance-announcement-dismiss")?.focus();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-slate-950/55 px-4 py-6">
      <section
        aria-describedby="maintenance-announcement-description maintenance-announcement-time"
        aria-labelledby="maintenance-announcement-title"
        aria-modal="true"
        className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-[0_24px_80px_rgba(15,23,42,0.28)] sm:p-7"
        role="dialog"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-full bg-rose-50 text-[var(--primary)]">
          <svg aria-hidden="true" className="h-6 w-6" fill="none" viewBox="0 0 24 24">
            <path d="M12 8v4.5m0 3.5h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
          </svg>
        </div>

        <h2 className="mt-5 text-2xl font-bold text-slate-950" id="maintenance-announcement-title">
          维护公告
        </h2>
        <p className="mt-3 text-base leading-7 text-[var(--foreground)]" id="maintenance-announcement-description">
          游戏服务正在进行维护更新，目前暂停使用，预计明天上午 8:00 恢复。
        </p>
        <p className="mt-5 border-t border-[var(--line)] pt-4 text-sm text-[var(--muted)]" id="maintenance-announcement-time">
          发布时间：2026年7月27日 15:00
        </p>

        <Button
          autoFocus
          className="mt-6 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-600 focus-visible:ring-offset-2"
          id="maintenance-announcement-dismiss"
          onClick={() => setIsOpen(false)}
          type="button"
        >
          我知道了
        </Button>
      </section>
    </div>
  );
}

function isPlayerCapacityError(errorCode: string | null | undefined) {
  return errorCode === PLAYER_CAPACITY_FULL_ERROR_CODE;
}

function isTeamSelectionRequired(errorCode: string | null | undefined) {
  return errorCode === TEAM_SELECTION_REQUIRED_ERROR_CODE;
}

type HomeFooterIcon = "video" | "rules" | "github" | "group" | "spark";

type HomeFooterLinkItemProps = {
  label: string;
  href: string | null;
  icon: HomeFooterIcon;
  external?: boolean;
  wide?: boolean;
};

function HomeFooterLinkItem({ label, href, icon, external = false, wide = false }: HomeFooterLinkItemProps) {
  const iconNode =
    icon === "video" ? (
      <svg aria-hidden="true" className="home-footer-icon" viewBox="0 0 24 24">
        <rect height="12" rx="2.5" width="15" x="3" y="6" />
        <path d="M18 10.2 22 8v8l-4-2.2" />
      </svg>
    ) : icon === "rules" ? (
      <svg aria-hidden="true" className="home-footer-icon" viewBox="0 0 24 24">
        <path d="M7 4.5h8.5A2.5 2.5 0 0 1 18 7v12H8.5A2.5 2.5 0 0 0 6 21.5V7A2.5 2.5 0 0 1 8.5 4.5Z" />
        <path d="M6 7.5h9" />
        <path d="M9 11h6" />
        <path d="M9 14.5h6" />
      </svg>
    ) : icon === "github" ? (
      <svg aria-hidden="true" className="home-footer-icon" viewBox="0 0 24 24">
        <path d="M12 2.5a9.5 9.5 0 0 0-3 18.52c.48.09.65-.2.65-.47v-1.66c-2.64.57-3.2-1.12-3.2-1.12-.43-1.1-1.06-1.4-1.06-1.4-.86-.59.07-.58.07-.58.95.07 1.45.97 1.45.97.84 1.44 2.21 1.02 2.75.78.09-.61.33-1.02.6-1.26-2.1-.24-4.31-1.05-4.31-4.67 0-1.03.37-1.88.97-2.54-.1-.24-.42-1.22.09-2.54 0 0 .79-.25 2.6.97A9.02 9.02 0 0 1 12 7.8c.8 0 1.6.1 2.35.31 1.8-1.22 2.59-.97 2.59-.97.52 1.32.2 2.3.1 2.54.6.66.97 1.51.97 2.54 0 3.63-2.21 4.42-4.32 4.66.34.29.64.86.64 1.74v2.58c0 .27.17.57.66.47A9.5 9.5 0 0 0 12 2.5Z" />
      </svg>
    ) : icon === "group" ? (
      <svg aria-hidden="true" className="home-footer-icon" viewBox="0 0 24 24">
        <path d="M8 12.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z" />
        <path d="M16.5 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z" />
        <path d="M3.5 18.5a4.5 4.5 0 0 1 9 0" />
        <path d="M13 18.5a3.8 3.8 0 0 1 7.5 0" />
      </svg>
    ) : (
      <svg aria-hidden="true" className="home-footer-icon" viewBox="0 0 24 24">
        <path d="m12 3 1.85 5.15L19 10l-5.15 1.85L12 17l-1.85-5.15L5 10l5.15-1.85L12 3Z" />
      </svg>
    );

  const content = (
    <>
      {iconNode}
      <span className="home-footer-link-text">
        <span>{label}</span>
        {external ? (
          <svg aria-hidden="true" className="home-footer-external-mark" viewBox="0 0 16 16">
            <path d="M5 11 11 5" />
            <path d="M6.5 5H11v4.5" />
          </svg>
        ) : null}
      </span>
    </>
  );

  if (!href) {
    return <span className={`home-footer-link home-footer-link-disabled${wide ? " home-footer-link-wide" : ""}`}>{content}</span>;
  }

  return (
    <a
      className={`home-footer-link${wide ? " home-footer-link-wide" : ""}`}
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {content}
    </a>
  );
}

function HomeFriendLinks() {
  return (
    <section aria-labelledby="home-friend-links-title" className="home-friend-links">
      <h2 className="home-friend-links-title" id="home-friend-links-title">
        友情链接
      </h2>
      <div className="home-friend-links-list">
        {FRIEND_LINKS.map((friendLink) => (
          <a
            aria-label={`${friendLink.label}（在新标签页打开）`}
            className="home-friend-link"
            href={friendLink.href}
            key={friendLink.href}
            rel="noopener noreferrer"
            target="_blank"
          >
            <span>{friendLink.label}</span>
            <svg aria-hidden="true" className="home-friend-link-icon" viewBox="0 0 16 16">
              <path d="M5 11 11 5" />
              <path d="M6.5 5H11v4.5" />
            </svg>
          </a>
        ))}
      </div>
    </section>
  );
}

export default function HomePage() {
  const router = useRouter();
  const [nickname, setNickname] = useState("");
  const [roomCode, setRoomCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [selectedRoomVisibility, setSelectedRoomVisibility] = useState<RoomVisibility | null>(null);
  const [publicRoomName, setPublicRoomName] = useState("");
  const privateRoomButtonRef = useRef<HTMLButtonElement>(null);
  const createDialogRef = useRef<HTMLElement>(null);
  const createDialogTriggerRef = useRef<HTMLElement | null>(null);
  const isSubmittingRef = useRef(false);

  useEffect(() => {
    const session = getLocalSession();
    const searchParams = new URLSearchParams(window.location.search);
    const roomCodeFromUrl = searchParams.get("roomCode") ?? "";
    const roomNotice = searchParams.get("roomNotice") ?? "";
    const publicRoomsNotice = searchParams.get("publicRoomsNotice") ?? "";

    let nextNotice = "";

    if (roomNotice === "kicked") {
      nextNotice = ROOM_REMOVAL_NOTICE;
      searchParams.delete("roomNotice");
      const nextSearch = searchParams.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`);
    }

    if (publicRoomsNotice === "nickname") {
      setError("请先输入昵称");
      searchParams.delete("publicRoomsNotice");
      const nextSearch = searchParams.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ""}`);
    }

    const validRoomCodeFromUrl = /^\d{6}$/.test(roomCodeFromUrl) ? roomCodeFromUrl : "";
    if (!nextNotice) nextNotice = getInviteNicknameNotice(validRoomCodeFromUrl, session.nickname);

    setNickname(session.nickname);
    setRoomCode(validRoomCodeFromUrl || session.roomCode || "");
    setNotice(nextNotice);
    if (validRoomCodeFromUrl && !session.nickname.trim()) {
      window.requestAnimationFrame(() => document.getElementById("home-nickname")?.focus());
    }
  }, []);

  useEffect(() => {
    isSubmittingRef.current = isSubmitting;
  }, [isSubmitting]);

  useEffect(() => {
    if (!isCreateDialogOpen) return;
    createDialogTriggerRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    privateRoomButtonRef.current?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !isSubmittingRef.current) setIsCreateDialogOpen(false);
      if (event.key === "Tab") {
        const focusable = Array.from(createDialogRef.current?.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled])",
        ) ?? []);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      createDialogTriggerRef.current?.focus();
    };
  }, [isCreateDialogOpen]);

  function validateNickname() {
    const trimmedNickname = nickname.trim();

    if (!trimmedNickname) {
      setError("请先输入昵称");
      return null;
    }

    return trimmedNickname;
  }

  function handleCreateRoom() {
    const trimmedNickname = validateNickname();
    if (!trimmedNickname) return;
    setError("");
    setNotice("");
    setSelectedRoomVisibility(null);
    setIsCreateDialogOpen(true);
  }

  async function submitCreateRoom(visibility: RoomVisibility) {
    const trimmedNickname = validateNickname();
    if (!trimmedNickname) return;

    setIsSubmitting(true);
    setError("");
    setNotice("");

    try {
      const session = getLocalSession();
      const room = await createRoom(session.playerId, trimmedNickname, {
        visibility,
        name: visibility === "PUBLIC" ? publicRoomName : undefined,
      });

      saveLocalSession({
        playerId: session.playerId,
        nickname: trimmedNickname,
        roomCode: room.code,
        isHost: true,
      });

      router.push(`/room/${room.code}`);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "创建房间失败，请稍后重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleJoinRoom() {
    const trimmedNickname = validateNickname();
    const trimmedRoomCode = roomCode.trim();

    if (!trimmedNickname) {
      return;
    }

    if (!/^\d{6}$/.test(trimmedRoomCode)) {
      setError("请输入 6 位房间号");
      return;
    }

    setIsSubmitting(true);
    setError("");
    setNotice("");

    try {
      const existingRoom = await getRoomWithPlayers(trimmedRoomCode);

      if (!existingRoom) {
        setError("房间不存在。请检查房间号是否正确");
        return;
      }

      let session = getLocalSession();
      const isSameStoredRoom = session.roomCode === trimmedRoomCode;

      if (!isSameStoredRoom && session.nickname && session.nickname !== trimmedNickname) {
        session = createNewLocalPlayerSession(trimmedNickname);
      }

      if (isRoomNicknameTaken(existingRoom.players, session.playerId, trimmedNickname)) {
        setError("该昵称已在房间内使用，请换一个昵称。");
        return;
      }

      if (existingRoom.status === "PLAYING") {
        saveLocalSession({
          playerId: session.playerId,
          nickname: trimmedNickname,
          roomCode: trimmedRoomCode,
          isHost: existingRoom.hostPlayerId === session.playerId,
        });

        router.push(`/room/${existingRoom.code}`);
        return;
      }

      const result = await joinRoom(trimmedRoomCode, session.playerId, trimmedNickname);

      if (result.error || !result.room) {
        if (isPlayerCapacityError(result.errorCode) || isTeamSelectionRequired(result.errorCode)) {
          saveLocalSession({
            playerId: session.playerId,
            nickname: trimmedNickname,
            roomCode: existingRoom.code,
            isHost: existingRoom.hostPlayerId === session.playerId,
          });

          router.push(`/room/${existingRoom.code}`);
          return;
        }

        setError(result.error ?? "加入房间失败，请稍后重试");
        return;
      }

      const isHost = result.room.hostPlayerId === session.playerId;

      saveLocalSession({
        playerId: session.playerId,
        nickname: trimmedNickname,
        roomCode: result.room.code,
        isHost,
      });

      router.push(`/room/${result.room.code}`);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "加入房间失败，请稍后重试");
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleBrowsePublicRooms() {
    const trimmedNickname = validateNickname();
    if (!trimmedNickname) return;
    const session = getLocalSession();
    saveLocalSession({ playerId: session.playerId, nickname: trimmedNickname });
    setError("");
    setNotice("");
    router.push("/public-rooms");
  }

  return (
    <AppShell>
      {SHOW_MAINTENANCE_ANNOUNCEMENT ? <MaintenanceAnnouncement /> : null}
      <div className="grid min-h-[calc(100vh-64px)] content-center gap-6">
        <div className="grid items-center gap-8 lg:grid-cols-[1.1fr_0.9fr]">
          <section>
            <div className="mb-6 inline-flex items-center rounded-full border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-[var(--primary)] shadow-sm">
              Anime Master Game
            </div>
            <h1 className="max-w-2xl text-4xl font-bold leading-tight text-slate-950 sm:text-5xl">
              动漫高手·一眼顶针
            </h1>
            <p className="mt-5 max-w-xl text-base leading-7 text-[var(--muted)]">
              和朋友一起开格子猜动画
            </p>
            <div className="mt-6 flex flex-col gap-3 sm:flex-row">
              <QuestionGuideButton className="w-full sm:w-auto" />
              <CommunityScreenshotUploadButton className="w-full sm:w-auto" nickname={nickname} />
            </div>
            <div className="mt-8 grid max-w-xl gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-white bg-white/70 p-4 shadow-sm">
                <p className="text-xl font-bold text-slate-950">逐格揭图</p>
                <p className="mt-1 text-xs text-[var(--muted)]">看线索猜动画名</p>
              </div>
              <div className="rounded-lg border border-white bg-white/70 p-4 shadow-sm">
                <p className="text-xl font-bold text-slate-950">14w+ 截图题库</p>
                <p className="mt-1 text-xs text-[var(--muted)]">覆盖 2k+ 部动画</p>
              </div>
              <div className="rounded-lg border border-white bg-white/70 p-4 shadow-sm">
                <p className="text-xl font-bold text-slate-950">题库社区</p>
                <p className="mt-1 text-xs text-[var(--muted)]">好题发布复用</p>
              </div>
            </div>
          </section>

          <Panel>
            <div className="space-y-4">
              <FormField
                id="home-nickname"
                label="昵称"
                maxLength={20}
                placeholder="例如：小明"
                value={nickname}
                onChange={(event) => {
                  setNickname(event.target.value);
                  setError("");
                  setNotice("");
                }}
              />

              <Button className="w-full" type="button" onClick={handleCreateRoom} disabled={isSubmitting}>
                {isSubmitting ? "处理中…" : "创建房间"}
              </Button>

              <div className="border-t border-[var(--line)] pt-4">
                <FormField
                  label="房间号"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="输入 6 位房间号"
                  value={roomCode}
                  onChange={(event) => {
                    setRoomCode(event.target.value.replace(/\D/g, "").slice(0, 6));
                    setError("");
                    setNotice("");
                  }}
                />
                <Button
                  className="mt-4 w-full"
                  type="button"
                  variant="secondary"
                  onClick={handleJoinRoom}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? "处理中…" : "加入房间"}
                </Button>
              </div>

              <div className="border-t border-[var(--line)] pt-4">
                <Button className="w-full" type="button" variant="secondary" onClick={handleBrowsePublicRooms} disabled={isSubmitting}>
                  浏览公开房间
                </Button>
              </div>

              {error ? <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
              {notice ? <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-800" role="status">{notice}</p> : null}
            </div>
          </Panel>
        </div>

        <footer className="home-footer" aria-label="相关信息">
          <div className="home-footer-content">
            <div className="home-footer-grid">
              <HomeFooterLinkItem href={INTRO_VIDEO_URL} icon="video" label="视频介绍" />
              <HomeFooterLinkItem href={null} icon="rules" label="文字规则（待补）" />
              <HomeFooterLinkItem href={GITHUB_REPO_URL} icon="github" label="Github 仓库" />
              <HomeFooterLinkItem href={FEEDBACK_QQ_GROUP_URL} icon="group" label="游戏QQ群" />
              <HomeFooterLinkItem external href={OTHER_GAME_URL} icon="spark" label="更多游戏：动漫高手截码战" wide />
            </div>
            <HomeFriendLinks />
          </div>
        </footer>
      </div>
      {isCreateDialogOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/50 px-4 py-6" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !isSubmitting) setIsCreateDialogOpen(false);
        }}>
          <section ref={createDialogRef} aria-labelledby="create-room-title" aria-modal="true" className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-[0_24px_70px_rgba(15,23,42,0.22)]" role="dialog">
            <h2 className="text-2xl font-bold text-slate-950" id="create-room-title">选择房间类型</h2>
            <div className="mt-6 grid gap-4 sm:grid-cols-2">
              <button aria-pressed={selectedRoomVisibility === "PRIVATE"} ref={privateRoomButtonRef} className={`min-h-24 rounded-xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 ${selectedRoomVisibility === "PRIVATE" ? "border-rose-300 bg-rose-50/60" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"}`} disabled={isSubmitting} onClick={() => setSelectedRoomVisibility("PRIVATE")} type="button">
                <span className="block font-bold text-slate-950">私人房间</span>
                <span className="mt-1 block text-sm leading-6 text-[var(--muted)]">通过房间号加入</span>
              </button>
              <button aria-pressed={selectedRoomVisibility === "PUBLIC"} className={`min-h-24 rounded-xl border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2 ${selectedRoomVisibility === "PUBLIC" ? "border-rose-300 bg-rose-50/60" : "border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50"}`} disabled={isSubmitting} onClick={() => setSelectedRoomVisibility("PUBLIC")} type="button">
                <span className="block font-bold text-slate-950">公开房间</span>
                <span className="mt-1 block text-sm leading-6 text-[var(--muted)]">所有玩家可见</span>
              </button>
            </div>
            {selectedRoomVisibility === "PUBLIC" ? (
              <label className="mt-5 block text-sm font-medium text-slate-700" htmlFor="public-room-name">
                房间名称（选填）
                <input autoFocus className="mt-2 h-11 w-full rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-rose-400 focus:ring-2 focus:ring-rose-100" id="public-room-name" maxLength={40} onChange={(event) => setPublicRoomName(event.target.value)} placeholder={`${nickname.trim()}的房间`} value={publicRoomName} />
              </label>
            ) : null}
            {error ? <p className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <Button disabled={isSubmitting} onClick={() => setIsCreateDialogOpen(false)} type="button" variant="secondary">取消</Button>
              <Button className="shadow-none" disabled={isSubmitting || !selectedRoomVisibility} onClick={() => selectedRoomVisibility && void submitCreateRoom(selectedRoomVisibility)} type="button">
                {isSubmitting ? "创建中…" : "创建房间"}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </AppShell>
  );
}
