import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const assets = [
    { symbol: "BTCUSDT", assetType: "CRYPTO" as const, exchange: "BINANCE", name: "Bitcoin / USDT" },
    { symbol: "ETHUSDT", assetType: "CRYPTO" as const, exchange: "BINANCE", name: "Ethereum / USDT" },
    { symbol: "AAPL", assetType: "STOCK" as const, exchange: "NASDAQ", name: "Apple Inc." },
  ];

  for (const asset of assets) {
    await prisma.asset.upsert({
      where: { symbol_assetType: { symbol: asset.symbol, assetType: asset.assetType } },
      update: {},
      create: asset,
    });
  }

  console.log(`Seeded ${assets.length} assets.`);
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
