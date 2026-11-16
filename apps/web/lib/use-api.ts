"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, get } from "./api";

/**
 * Load data from the API with loading/error state. With `pollMs`, it keeps polling while `pollWhile(data)` is true.
 * Any load (including a manual reload after an upload) re-evaluates polling, so the view never freezes on a stale state.
 */
export function useApi<T>(path: string | null, opts: { pollMs?: number; pollWhile?: (d: T) => boolean } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);

  const load = useCallback(async (): Promise<T | undefined> => {
    if (!path) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    let d: T | undefined;
    try {
      d = await get<T>(path);
      if (!alive.current) return d;
      setData(d);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof ApiError ? e : new ApiError("NETWORK", (e as Error).message, 0));
    } finally {
      if (alive.current) setLoading(false);
    }
    const { pollMs, pollWhile } = optsRef.current;
    if (alive.current && pollMs && d !== undefined && (!pollWhile || pollWhile(d))) {
      timer.current = setTimeout(() => void load(), pollMs);
    }
    return d;
  }, [path]);

  useEffect(() => {
    alive.current = true;
    setLoading(!!path);
    void load();
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load, path]);

  return { data, error, loading, reload: load, setData };
}
