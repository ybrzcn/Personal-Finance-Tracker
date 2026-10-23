import { Fragment, type ReactNode } from "react";

/** Çevrilmiş cümledeki `{ad}` yer tutucularına öğe yerleştirir (vurgulu parçalar dilin söz dizimine göre yer değiştirebilsin) */
export function rich(s: string, nodes: Record<string, ReactNode>): ReactNode {
  return s.split(/(\{\w+\})/).map((part, i) => {
    const m = part.match(/^\{(\w+)\}$/);
    return <Fragment key={i}>{m && m[1] in nodes ? nodes[m[1]] : part}</Fragment>;
  });
}
