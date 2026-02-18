import { NextResponse } from "next/server";

type Body = {
  action?: string;
  turnsUsed?: number;
  pairsFound?: number;
  completed?: boolean;
  solveMs?: number;
  pointsDelta?: number;
};

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Body;

    if (body.action === "ping") {
      return NextResponse.json({ ok: true, message: "pong" });
    }

    if (body.action !== "submitRound") {
      return NextResponse.json(
        { ok: false, error: "Unsupported action" },
        { status: 400 }
      );
    }

    const turnsUsed = Number(body.turnsUsed ?? -1);
    const pairsFound = Number(body.pairsFound ?? -1);
    const solveMs = Number(body.solveMs ?? -1);
    const pointsDelta = Number(body.pointsDelta ?? -1);
    const completed = Boolean(body.completed);

    if (
      !Number.isFinite(turnsUsed) ||
      !Number.isFinite(pairsFound) ||
      !Number.isFinite(solveMs) ||
      !Number.isFinite(pointsDelta) ||
      turnsUsed < 0 ||
      pairsFound < 0 ||
      solveMs < 0 ||
      pointsDelta < 0
    ) {
      return NextResponse.json(
        { ok: false, error: "Invalid payload" },
        { status: 400 }
      );
    }

    console.log("[unity-api] submitRound", {
      turnsUsed,
      pairsFound,
      completed,
      solveMs,
      pointsDelta,
      receivedAt: new Date().toISOString(),
    });

    return NextResponse.json({
      ok: true,
      accepted: true,
      summary: {
        turnsUsed,
        pairsFound,
        completed,
        solveMs,
        pointsDelta,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
