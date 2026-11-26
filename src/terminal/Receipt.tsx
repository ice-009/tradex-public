"use client";

import "./receipts.css";
import { receiptLine, type Receipt } from "@/core/lab/receipt";

// Receipts (#29): every factor, screen and plan idea shows its proof in one
// line and links to its report card (/lab/<signal>). Rules in src/core/lab/receipt.ts.

const stop = (event: { stopPropagation(): void }) => event.stopPropagation();

const passText = (receipt: Receipt) =>
  receipt.subject === "factor"
    ? receipt.promotable
      ? "Counts in the score: its report card passes in this market."
      : "Not counted as proven: no passing report card in this market."
    : receipt.promotable
      ? "Passes the plan's evidence rule in this market."
      : "Doesn't pass the plan's evidence rule in this market.";

/** "Report card ↗ Feb 2022–Nov 2026 · uptrends only · +0.07R/trade (1d) · …" */
export function ReceiptLine({ receipt, className = "" }: { receipt: Receipt; className?: string }) {
  return (
    <span className={`tx-receipt ${receipt.promotable ? "is-proven" : "is-unproven"} ${className}`} title={`${receipt.name}: ${passText(receipt)}`}>
      <span className="tx-receipt-mark" aria-hidden>
        {receipt.promotable ? "✓" : "○"}
      </span>
      <a className="tx-receipt-card" href={receipt.cardHref} target="_blank" rel="noopener" onClick={stop} aria-label={`Report card: ${receipt.name}`}>
        Report card ↗
      </a>
      <span className="tx-receipt-text">{receiptLine(receipt)}</span>
    </span>
  );
}

/** A small "↗" link to the card, the receipt in its tooltip (for table cells). */
export function ReceiptLink({ receipt }: { receipt: Receipt }) {
  return (
    <a
      className="tx-receipt-link"
      href={receipt.cardHref}
      target="_blank"
      rel="noopener"
      onClick={stop}
      title={`${receipt.name} — report card\n${receiptLine(receipt)}\n${passText(receipt)}`}
      aria-label={`Report card: ${receipt.name}`}
    >
      ↗
    </a>
  );
}
