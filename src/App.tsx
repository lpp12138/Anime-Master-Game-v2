import { useEffect, useRef, useState } from "react";
import HomePage from "@/app/page";
import RoomPage from "@/app/room/[roomCode]/page";
import PublicRoomsPage from "@/app/public-rooms/page";
import CommunityUploadPage from "@/app/community-upload/page";
import { requestAppRouteChange } from "@/lib/router";

function currentPath() {
  return window.location.pathname;
}

function currentRelativeUrl() {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

export default function App() {
  const [path, setPath] = useState(currentPath);
  const currentUrlRef = useRef(currentRelativeUrl());
  const currentHistoryStateRef = useRef(window.history.state);

  useEffect(() => {
    function handleRouteChange(event: Event) {
      const nextUrl = currentRelativeUrl();
      if (
        event.type === "popstate"
        && nextUrl !== currentUrlRef.current
        && !requestAppRouteChange(nextUrl, "popstate")
      ) {
        window.history.pushState(currentHistoryStateRef.current, "", currentUrlRef.current);
        return;
      }
      currentUrlRef.current = nextUrl;
      currentHistoryStateRef.current = window.history.state;
      setPath(currentPath());
    }

    window.addEventListener("popstate", handleRouteChange);
    window.addEventListener("app-route-change", handleRouteChange);
    handleRouteChange(new Event("app-route-change"));

    return () => {
      window.removeEventListener("popstate", handleRouteChange);
      window.removeEventListener("app-route-change", handleRouteChange);
    };
  }, []);

  const roomMatch = path.match(/^\/room\/([^/]+)/);

  if (roomMatch) {
    return <RoomPage initialRoomCode={decodeURIComponent(roomMatch[1])} />;
  }

  if (path === "/public-rooms") return <PublicRoomsPage />;
  if (path === "/community-upload") return <CommunityUploadPage />;

  return <HomePage />;
}
