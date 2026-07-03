export type { Asset, AssetType } from "@trading-alert-dashboard/shared";

export interface CreateAssetInput {
  symbol: string;
  assetType: "CRYPTO" | "STOCK";
  name?: string;
  exchange?: string;
  isActive?: boolean;
}

export interface UpdateAssetInput {
  name?: string;
  exchange?: string;
  isActive?: boolean;
}
