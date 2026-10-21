import { useEffect, useState } from "react";
import { todayISO } from "../lib/format";

/** Bugünün tarihi (YYYY-MM-DD); uygulama açık kalırken gün dönünce güncellenir. */
export function useToday(): string {
  const [day, setDay] = useState(todayISO);
  useEffect(() => {
    const tick = () => setDay(todayISO());
    const id = window.setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  return day;
}
