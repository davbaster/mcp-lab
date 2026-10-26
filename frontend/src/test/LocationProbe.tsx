import { useEffect } from "react";
import { useLocation, useNavigationType } from "react-router";

export interface Visit {
  /** Path, query and hash, for example `/courses/x?tab=1#top`. */
  url: string;
  type: "POP" | "PUSH" | "REPLACE";
}

export function LocationProbe({ visits }: { visits: Visit[] }) {
  const location = useLocation();
  const type = useNavigationType();
  useEffect(() => {
    const url = `${location.pathname}${location.search}${location.hash}`;
    const last = visits.at(-1);
    if (last?.url !== url || last.type !== type) visits.push({ url, type });
  }, [location, type, visits]);
  return null;
}
