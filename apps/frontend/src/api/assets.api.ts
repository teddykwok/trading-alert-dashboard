import { apiClient } from "./client";
import type { Asset, CreateAssetInput, UpdateAssetInput } from "../types/asset";

export const assetsApi = {
  list: () => apiClient.get<Asset[]>("/api/assets"),
  create: (input: CreateAssetInput) => apiClient.post<Asset>("/api/assets", input),
  update: (id: string, input: UpdateAssetInput) => apiClient.patch<Asset>(`/api/assets/${id}`, input),
  remove: (id: string) => apiClient.delete<void>(`/api/assets/${id}`),
};
