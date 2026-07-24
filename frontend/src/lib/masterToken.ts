"use client";

import { useEffect, useState } from "react";

export type MasterTokenData = {
  pillCount: number;
  identifications: Array<{
    drug_names: string[];
    confidences: number[];
    rotation: number;
    adjustments: number;
    latency_ms: number;
  }>;
};

// Generate master token in the format:
// [PILOT_BATCH|Count:N] { P1:drug1|drug2|...|ndc1|ndc2|...|Conf:[%|%|...]|Rot:X|Adj:Y|Lat:Zs }
function formatMasterToken(data: MasterTokenData): string {
  if (data.pillCount === 0) return "";

  const identifications = data.identifications.map((id, idx) => {
    const drugs = id.drug_names.join("|");
    const confs = id.confidences.map((c) => `${(c * 100).toFixed(1)}%`).join("|");
    const lat_sec = (id.latency_ms / 1000).toFixed(1);
    return `P${idx + 1}:${drugs}|Conf:[${confs}]|Rot:${id.rotation}|Adj:${id.adjustments}|Lat:${lat_sec}s`;
  });

  return `[PILOT_BATCH|Count:${data.pillCount}] { ${identifications.join(" | ")} }`;
}

export function useMasterToken() {
  const [data, setData] = useState<MasterTokenData>({ pillCount: 0, identifications: [] });
  const [token, setToken] = useState("");

  const addIdentification = (
    drug_names: string[],
    confidences: number[],
    rotation: number,
    adjustments: number,
    latency_ms: number
  ) => {
    setData((prev) => {
      const newData = {
        pillCount: prev.pillCount + 1,
        identifications: [
          ...prev.identifications,
          { drug_names, confidences, rotation, adjustments, latency_ms },
        ],
      };
      setToken(formatMasterToken(newData));
      return newData;
    });
  };

  const copyToken = async () => {
    await navigator.clipboard.writeText(token);
    return true;
  };

  const resetToken = () => {
    setData({ pillCount: 0, identifications: [] });
    setToken("");
  };

  return {
    token,
    pillCount: data.pillCount,
    copyToken,
    resetToken,
    addIdentification,
  };
}