"use client";

import { useState } from "react";
import { INDICATOR_CATEGORIES, INDICATOR_LIST } from "@/core/indicators/indicators";
import { addIndicator, useTerminal } from "./store";
import { Icons } from "./icons";
import { Modal } from "./ui";

export function IndicatorsDialog({ onClose }: { onClose: () => void }) {
  const activeCell = useTerminal((state) => state.activeCell);
  const indicators = useTerminal((state) => state.cells[state.activeCell].indicators);
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const matches = INDICATOR_LIST.filter(
    (def) =>
      !q ||
      def.name.toLowerCase().includes(q) ||
      def.type.includes(q) ||
      def.description.toLowerCase().includes(q) ||
      def.category.includes(q) ||
      (def.popularInIndia === true && "india".includes(q)),
  );
  const groups = INDICATOR_CATEGORIES.map((category) => ({
    title: category.title,
    items: matches.filter((def) => def.category === category.key),
  }));

  return (
    <Modal title="Indicators" onClose={onClose} width={620}>
      <div className="tx-search-box">
        <Icons.search size={16} />
        <input
          autoFocus
          className="tx-search-input"
          placeholder="Search indicators"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="tx-search-results">
        {groups.map((group) =>
          group.items.length ? (
            <div key={group.title}>
              <div className="tx-section-label tx-section-pad">{group.title}</div>
              {group.items.map((def) => {
                const count = indicators.filter((indicator) => indicator.type === def.type).length;
                return (
                  <button
                    type="button"
                    key={def.type}
                    className="tx-search-row"
                    title={def.description}
                    onClick={() => addIndicator(activeCell, def.type)}
                  >
                    <span className="tx-ind-name">{def.name}</span>
                    <span className="tx-search-name">{def.description}</span>
                    {def.popularInIndia && (
                      <span className="tx-tag" title="Widely used by Indian traders">
                        Popular in India
                      </span>
                    )}
                    {count > 0 && <span className="tx-tag tx-tag-index">{count} on chart</span>}
                    <Icons.plus size={15} />
                  </button>
                );
              })}
            </div>
          ) : null,
        )}
        {!matches.length && <div className="tx-section-label tx-section-pad">No indicators match “{query}”</div>}
      </div>
    </Modal>
  );
}
