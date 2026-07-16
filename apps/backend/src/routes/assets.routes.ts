import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ASSET_TYPES, getSymbolInputError } from "@trading-alert-dashboard/shared";
import { NotFoundError, ValidationError } from "../utils/errors";

const createAssetSchema = z.object({
  symbol: z.string().min(1),
  assetType: z.enum(ASSET_TYPES),
  name: z.string().optional(),
  exchange: z.string().optional(),
  isActive: z.boolean().optional(),
});

const updateAssetSchema = z.object({
  name: z.string().optional(),
  exchange: z.string().optional(),
  isActive: z.boolean().optional(),
});

export async function assetsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/assets", async () => {
    return app.prisma.asset.findMany({ orderBy: { symbol: "asc" } });
  });

  app.post("/api/assets", async (request, reply) => {
    const parsed = createAssetSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid asset payload", parsed.error.flatten());
    }

    // Rejects pasted watchlists ("BTCUSDT, ETHUSDT, …") and other
    // whitespace/separator garbage; single tickers of any exchange pass.
    const symbol = parsed.data.symbol.trim();
    const symbolError = getSymbolInputError(symbol);
    if (symbolError) {
      throw new ValidationError(symbolError, { field: "symbol" });
    }

    const asset = await app.prisma.asset.create({
      data: {
        symbol,
        assetType: parsed.data.assetType,
        name: parsed.data.name ?? null,
        exchange: parsed.data.exchange ?? null,
        isActive: parsed.data.isActive ?? true,
      },
    });

    return reply.code(201).send(asset);
  });

  app.patch<{ Params: { id: string } }>("/api/assets/:id", async (request) => {
    const parsed = updateAssetSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("Invalid asset update", parsed.error.flatten());
    }

    const existing = await app.prisma.asset.findUnique({ where: { id: request.params.id } });
    if (!existing) throw new NotFoundError(`Asset ${request.params.id} not found`);

    return app.prisma.asset.update({ where: { id: request.params.id }, data: parsed.data });
  });

  app.delete<{ Params: { id: string } }>("/api/assets/:id", async (request, reply) => {
    const existing = await app.prisma.asset.findUnique({ where: { id: request.params.id } });
    if (!existing) throw new NotFoundError(`Asset ${request.params.id} not found`);

    await app.prisma.asset.delete({ where: { id: request.params.id } });
    return reply.code(204).send();
  });
}
