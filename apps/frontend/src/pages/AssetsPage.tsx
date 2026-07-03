import { useEffect, useState, type FormEvent } from "react";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Badge } from "../components/ui/Badge";
import { Modal } from "../components/ui/Modal";
import { EmptyState } from "../components/ui/EmptyState";
import { assetsApi } from "../api/assets.api";
import type { Asset } from "../types/asset";

interface AssetFormState {
  symbol: string;
  assetType: "CRYPTO" | "STOCK";
  name: string;
  exchange: string;
}

const EMPTY_FORM: AssetFormState = { symbol: "", assetType: "CRYPTO", name: "", exchange: "" };

export function AssetsPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState<AssetFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);

  async function refetch() {
    setLoading(true);
    const items = await assetsApi.list();
    setAssets(items);
    setLoading(false);
  }

  useEffect(() => {
    refetch();
  }, []);

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  }

  function openEdit(asset: Asset) {
    setEditingId(asset.id);
    setForm({
      symbol: asset.symbol,
      assetType: asset.assetType,
      name: asset.name ?? "",
      exchange: asset.exchange ?? "",
    });
    setModalOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (editingId) {
      await assetsApi.update(editingId, { name: form.name || undefined, exchange: form.exchange || undefined });
    } else {
      await assetsApi.create({
        symbol: form.symbol,
        assetType: form.assetType,
        name: form.name || undefined,
        exchange: form.exchange || undefined,
      });
    }
    setModalOpen(false);
    await refetch();
  }

  async function toggleActive(asset: Asset) {
    await assetsApi.update(asset.id, { isActive: !asset.isActive });
    await refetch();
  }

  async function handleDelete(id: string) {
    await assetsApi.remove(id);
    await refetch();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-100">Assets</h1>
        <Button onClick={openCreate}>Add asset</Button>
      </div>

      {loading ? (
        <p className="text-sm text-slate-500">Loading…</p>
      ) : assets.length === 0 ? (
        <EmptyState title="No assets yet" description="Add the symbols you want to monitor alerts for." />
      ) : (
        <div className="flex flex-col gap-2">
          {assets.map((asset) => (
            <Card key={asset.id} className="flex items-center justify-between p-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-100">{asset.symbol}</span>
                  <span className="text-xs text-slate-500">{asset.assetType}</span>
                  <Badge tone={asset.isActive ? "green" : "gray"}>
                    {asset.isActive ? "Active" : "Inactive"}
                  </Badge>
                </div>
                {(asset.name || asset.exchange) && (
                  <p className="mt-0.5 text-xs text-slate-500">
                    {[asset.name, asset.exchange].filter(Boolean).join(" · ")}
                  </p>
                )}
              </div>

              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => toggleActive(asset)}>
                  {asset.isActive ? "Deactivate" : "Activate"}
                </Button>
                <Button variant="secondary" onClick={() => openEdit(asset)}>
                  Edit
                </Button>
                <Button variant="danger" onClick={() => handleDelete(asset.id)}>
                  Delete
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={editingId ? "Edit asset" : "Add asset"}>
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <input
            required
            disabled={Boolean(editingId)}
            placeholder="Symbol (e.g. BTCUSDT)"
            value={form.symbol}
            onChange={(e) => setForm((f) => ({ ...f, symbol: e.target.value }))}
            className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm disabled:opacity-50"
          />
          <select
            disabled={Boolean(editingId)}
            value={form.assetType}
            onChange={(e) => setForm((f) => ({ ...f, assetType: e.target.value as "CRYPTO" | "STOCK" }))}
            className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm disabled:opacity-50"
          >
            <option value="CRYPTO">CRYPTO</option>
            <option value="STOCK">STOCK</option>
          </select>
          <input
            placeholder="Display name (optional)"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm"
          />
          <input
            placeholder="Exchange (optional)"
            value={form.exchange}
            onChange={(e) => setForm((f) => ({ ...f, exchange: e.target.value }))}
            className="rounded-lg border border-surface-border bg-surface px-3 py-2 text-sm"
          />
          <Button type="submit">{editingId ? "Save changes" : "Add asset"}</Button>
        </form>
      </Modal>
    </div>
  );
}
