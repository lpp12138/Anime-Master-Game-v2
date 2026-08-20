export const APP_BEFORE_ROUTE_CHANGE_EVENT = "app-before-route-change";

type RouteChangeSource = "push" | "replace" | "popstate";

export type AppBeforeRouteChangeDetail = {
  path: string;
  source: RouteChangeSource;
};

export function requestAppRouteChange(path: string, source: RouteChangeSource) {
  return window.dispatchEvent(new CustomEvent<AppBeforeRouteChangeDetail>(APP_BEFORE_ROUTE_CHANGE_EVENT, {
    cancelable: true,
    detail: { path, source },
  }));
}

export function useRouter() {
  return {
    push(path: string, state: unknown = null) {
      if (!requestAppRouteChange(path, "push")) return;
      window.history.pushState(state, "", path);
      window.dispatchEvent(new Event("app-route-change"));
    },
    replace(path: string, state: unknown = null) {
      if (!requestAppRouteChange(path, "replace")) return;
      window.history.replaceState(state, "", path);
      window.dispatchEvent(new Event("app-route-change"));
    },
  };
}

export function useParams<T extends Record<string, string>>() {
  const roomMatch = window.location.pathname.match(/^\/room\/([^/]+)/);
  return {
    roomCode: roomMatch ? decodeURIComponent(roomMatch[1]) : "",
  } as unknown as T;
}
