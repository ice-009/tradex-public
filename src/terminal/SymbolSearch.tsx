"use client";

import { useEffect, useRef, useState } from "react";
import { searchSymbols, type SymbolInfo } from "@/client/marketData";
import { Icons } from "./icons";
import { Modal } from "./ui";

export function SymbolSearch({
  initialQuery,
  title,
  onSelect,
  onClose,
}: {
  initialQuery: string;
  title: string;
  onSelect: (symbol: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [results, setResults] = useState<SymbolInfo[]>([]);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      searchSymbols(query, controller.signal)
        .then((items) => {
          setResults(items);
          setCursor(0);
        })
        .catch(() => {});
    }, 100);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const choose = (item: SymbolInfo | undefined) => {
    if (!item) return;
    onSelect(item.symbol);
    onClose();
  };

  return (
    <Modal title={title} onClose={onClose} width={560}>
      <div className="tx-search-box">
        <Icons.search size={16} />
        <input
          autoFocus
          className="tx-search-input"
          placeholder="Symbol or company, e.g. RELIANCE, Nifty Bank"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setCursor((value) => Math.min(results.length - 1, value + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setCursor((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter") {
              choose(results[cursor]);
            }
          }}
        />
      </div>
      <div className="tx-search-results" ref={listRef}>
        {results.length === 0 && <div className="tx-empty">No matching symbols</div>}
        {results.map((item, index) => (
          <button
            type="button"
            key={item.symbol}
            data-index={index}
            className={`tx-search-row ${index === cursor ? "is-cursor" : ""}`}
            onMouseEnter={() => setCursor(index)}
            onClick={() => choose(item)}
          >
            <span className="tx-search-symbol">{item.symbol}</span>
            <span className="tx-search-name">{item.name}</span>
            <span className={`tx-tag ${item.type === "index" ? "tx-tag-index" : ""}`}>{item.type}</span>
            <span className="tx-search-exch">{item.exchange}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
