"use client";

import { CSSProperties, FormEvent, useCallback, useEffect, useState } from "react";
import { ethers } from "ethers";
import {
  connectContracts,
  CONTRACT_ADDRESSES,
  ContractInstances,
  erc20Abi,
  erc721Abi,
} from "../lib/contract";

type PoolDisplay = {
  poolId: number;
  active: boolean;
  salePriceEth: string;
  amountForSale: number;
  sold: number;
  totalFractions: number;
  tokenId: number;
  ftAddress: string;
  claimableEth: string;
  userBalance: string;
  originalOwner: string;
};

type AssetDisplay = {
  assetId: number;
  metadataURI: string;
  royaltyBps: number;
  tokenId: number;
  nftContract: string;
  creator: string;
  owner: string;
  pool?: PoolDisplay;
};

type OfferDisplay = {
  offerId: number;
  assetId: number;
  seller: string;
  priceEth: string;
  royaltyBps: number;
  type: number;
  maxSupply: number;
  sold: number;
  duration: number;
  active: boolean;
  uri: string;
  assetUri?: string;
  exclusiveExpiry: number;
};

const licenseTypeLabels = ["Non-Exclusive", "Exclusive", "Derivative"];

const cardStyle: CSSProperties = {
  background: "#0f172a",
  borderRadius: 16,
  padding: 20,
  boxShadow: "0 12px 24px rgba(2,6,23,0.45)",
};

export default function Home() {
  const [account, setAccount] = useState("");
  const [network, setNetwork] = useState("");
  const [status, setStatus] = useState("");
  const [assets, setAssets] = useState<AssetDisplay[]>([]);
  const [offers, setOffers] = useState<OfferDisplay[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [addresses, setAddresses] = useState(CONTRACT_ADDRESSES);

  // register asset
  const [newAssetUri, setNewAssetUri] = useState("");
  const [newAssetRoyalty, setNewAssetRoyalty] = useState(500);

  // fractionalize form
  const [fractionalAssetId, setFractionalAssetId] = useState("");
  const [fractionalName, setFractionalName] = useState("Creator Fraction");
  const [fractionalSymbol, setFractionalSymbol] = useState("CFT");
  const [fractionalTotalSupply, setFractionalTotalSupply] = useState("1000");
  const [fractionalSalePrice, setFractionalSalePrice] = useState("0.001");
  const [fractionalAmountForSale, setFractionalAmountForSale] = useState("500");

  // buy fractions
  const [buyPoolId, setBuyPoolId] = useState("");
  const [buyAmount, setBuyAmount] = useState("10");

  // license offer
  const [offerAssetId, setOfferAssetId] = useState("");
  const [offerPrice, setOfferPrice] = useState("1");
  const [offerRoyaltyBps, setOfferRoyaltyBps] = useState(0);
  const [offerType, setOfferType] = useState("0");
  const [offerMaxSupply, setOfferMaxSupply] = useState("0");
  const [offerDuration, setOfferDuration] = useState("0");
  const [offerUri, setOfferUri] = useState("");

  const [buyOfferId, setBuyOfferId] = useState("");

  const loadEverything = useCallback(async () => {
    setLoadingData(true);
    setStatus("");
    try {
      const ctx = await connectContracts();
      setAccount(ctx.account);
      const net = await ctx.provider.getNetwork();
      setNetwork(`${net.name || "hardhat"} (${net.chainId.toString()})`);
      setAddresses(ctx.addresses);

      const assetList = await buildAssets(ctx);
      setAssets(assetList);

      const assetMap = new Map(assetList.map((a) => [a.assetId, a]));
      const offerList = await buildOffers(ctx, assetMap);
      setOffers(offerList);
    } catch (err) {
      setStatus(extractError(err));
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    loadEverything();
  }, [loadEverything, refreshNonce]);

  const refresh = () => setRefreshNonce((v) => v + 1);

  async function handleRegisterAsset(e: FormEvent) {
    e.preventDefault();
    setBusyAction("register");
    setStatus("");
    try {
      const ctx = await connectContracts();
      const tx = await ctx.assetRegistry.registerAsset(newAssetUri, newAssetRoyalty);
      await tx.wait();
      setStatus("Asset berhasil diregistrasi ✅");
      setNewAssetUri("");
      refresh();
    } catch (err) {
      setStatus(`Gagal register asset: ${extractError(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleFractionalize(e: FormEvent) {
    e.preventDefault();
    setBusyAction("fractionalize");
    setStatus("");
    try {
      const ctx = await connectContracts();
      const assetIdNum = Number(fractionalAssetId);
      if (!assetIdNum) throw new Error("Masukkan assetId yang valid");
      const asset = await ctx.assetRegistry.assets(assetIdNum);
      if (!asset.exists) throw new Error("Asset tidak ditemukan");

      const nft = new ethers.Contract(asset.nftContract, erc721Abi, ctx.signer);
      const approved = await nft.getApproved(asset.tokenId);
      if (approved.toLowerCase() !== ctx.addresses.fractionalizer.toLowerCase()) {
        const approveTx = await nft.approve(ctx.addresses.fractionalizer, asset.tokenId);
        await approveTx.wait();
      }

      const totalSupply = BigInt(fractionalTotalSupply || "0");
      const amountForSale = BigInt(fractionalAmountForSale || "0");
      const salePriceWei = ethers.parseEther(fractionalSalePrice || "0");

      const tx = await ctx.fractionalizer.fractionalize(
        assetIdNum,
        asset.nftContract,
        asset.tokenId,
        fractionalName,
        fractionalSymbol,
        totalSupply,
        salePriceWei,
        amountForSale,
        ctx.account
      );
      await tx.wait();

      const poolId = await ctx.fractionalizer.assetToPool(assetIdNum);
      const poolInfo = await ctx.fractionalizer.poolInfo(poolId);
      const ft = new ethers.Contract(poolInfo.ftAddress, erc20Abi, ctx.signer);
      const allowance = await ft.allowance(ctx.account, ctx.addresses.fractionalizer);
      if (allowance < amountForSale) {
        const approveSaleTx = await ft.approve(ctx.addresses.fractionalizer, amountForSale);
        await approveSaleTx.wait();
      }

      setStatus(`Berhasil fractionalize. Pool ID: ${poolId.toString()}`);
      refresh();
    } catch (err) {
      setStatus(`Gagal fractionalize: ${extractError(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleBuyFractions(e: FormEvent) {
    e.preventDefault();
    setBusyAction("buy-fractions");
    setStatus("");
    try {
      const ctx = await connectContracts();
      const poolIdNum = Number(buyPoolId);
      const amount = BigInt(buyAmount || "0");
      if (!poolIdNum || amount <= 0) throw new Error("Pool ID atau amount belum benar");

      const info = await ctx.fractionalizer.poolInfo(poolIdNum);
      const cost = info.salePricePerToken * amount;
      const tx = await ctx.fractionalizer.buyFractions(poolIdNum, amount, { value: cost });
      await tx.wait();
      setStatus("Berhasil membeli fractional token 🎉");
      refresh();
    } catch (err) {
      setStatus(`Gagal beli fraksi: ${extractError(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleClaim(poolId: number) {
    setBusyAction(`claim-${poolId}`);
    setStatus("");
    try {
      const ctx = await connectContracts();
      const tx = await ctx.fractionalizer.claimDividends(poolId);
      await tx.wait();
      setStatus(`Dividen pool ${poolId} berhasil diklaim`);
      refresh();
    } catch (err) {
      setStatus(`Gagal klaim dividen: ${extractError(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleCreateOffer(e: FormEvent) {
    e.preventDefault();
    setBusyAction("create-offer");
    setStatus("");
    try {
      const ctx = await connectContracts();
      const assetIdNum = Number(offerAssetId);
      if (!assetIdNum) throw new Error("Asset ID belum diisi");
      const priceWei = ethers.parseEther(offerPrice || "0");
      const tx = await ctx.licenseManager.createOffer(
        assetIdNum,
        priceWei,
        Number(offerRoyaltyBps),
        Number(offerType),
        BigInt(offerMaxSupply || "0"),
        BigInt(offerDuration || "0"),
        offerUri
      );
      await tx.wait();
      setStatus("License offer dibuat ✅");
      setOfferUri("");
      refresh();
    } catch (err) {
      setStatus(`Gagal membuat offer: ${extractError(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function handleBuyLicense(e: FormEvent) {
    e.preventDefault();
    setBusyAction("buy-license");
    setStatus("");
    try {
      const ctx = await connectContracts();
      const offerIdNum = Number(buyOfferId);
      if (!offerIdNum) throw new Error("Offer ID belum diisi");
      const offer = await ctx.licenseManager.offers(offerIdNum);
      if (!offer.offerId || offer.offerId === 0n) throw new Error("Offer tidak ditemukan");
      const tx = await ctx.licenseManager.buyLicense(offerIdNum, { value: offer.price });
      await tx.wait();
      setStatus("Lisensi berhasil dibeli 🎟️");
      refresh();
    } catch (err) {
      setStatus(`Gagal beli lisensi: ${extractError(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#020617", color: "#f8fafc" }}>
      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "40px 20px", display: "grid", gap: 24 }}>
        <header style={{ display: "grid", gap: 12 }}>
          <h1 style={{ fontSize: 28, margin: 0 }}>IP Market Dashboard</h1>
          <p style={{ margin: 0, color: "#cbd5f5" }}>
            Kelola siklus aset: registrasi IP, fractionalize NFT, jual fraction, buat lisensi, dan tarik royalti —
            semua dari satu halaman.
          </p>
          {status && (
            <div style={{ padding: "12px 16px", borderRadius: 12, background: "#f97316", color: "#0f172a", fontWeight: 600 }}>
              {status}
            </div>
          )}
        </header>

        <section style={{ ...cardStyle, display: "grid", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Koneksi</h2>
          <div>Account: {account ? shorten(account) : "Belum terhubung"}</div>
          <div>Network: {network || "-"}</div>
          <div style={{ fontSize: 13, color: "#94a3b8" }}>
            AssetRegistry: {shorten(addresses.assetRegistry)} | Fractionalizer: {shorten(addresses.fractionalizer)} | LicenseManager:{" "}
            {shorten(addresses.licenseManager)}
          </div>
          {loadingData && <span style={{ fontSize: 13 }}>Memuat data terbaru...</span>}
        </section>

        <section style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))" }}>
          <div style={cardStyle}>
            <h3 style={{ marginTop: 0 }}>1. Register Asset</h3>
            <form style={{ display: "grid", gap: 10 }} onSubmit={handleRegisterAsset}>
              <label style={{ fontSize: 14 }}>
                Metadata URI
                <input
                  value={newAssetUri}
                  onChange={(e) => setNewAssetUri(e.target.value)}
                  required
                  placeholder="ipfs://..."
                  style={inputStyle}
                />
              </label>
              <label style={{ fontSize: 14 }}>
                Default Royalty (bps)
                <input
                  type="number"
                  min={0}
                  max={10000}
                  value={newAssetRoyalty}
                  onChange={(e) => setNewAssetRoyalty(Number(e.target.value))}
                  style={inputStyle}
                />
              </label>
              <button style={buttonStyle} type="submit" disabled={busyAction === "register"}>
                {busyAction === "register" ? "Mengirim..." : "Register"}
              </button>
            </form>
          </div>

          <div style={cardStyle}>
            <h3 style={{ marginTop: 0 }}>2. Fractionalize</h3>
            <form style={{ display: "grid", gap: 10 }} onSubmit={handleFractionalize}>
              <label style={{ fontSize: 14 }}>
                Asset ID
                <input value={fractionalAssetId} onChange={(e) => setFractionalAssetId(e.target.value)} required style={inputStyle} />
              </label>
              <label style={{ fontSize: 14 }}>
                Token name & symbol
                <div style={{ display: "grid", gap: 8, gridTemplateColumns: "2fr 1fr" }}>
                  <input value={fractionalName} onChange={(e) => setFractionalName(e.target.value)} required style={inputStyle} />
                  <input value={fractionalSymbol} onChange={(e) => setFractionalSymbol(e.target.value)} required style={inputStyle} />
                </div>
              </label>
              <label style={{ fontSize: 14 }}>
                Total supply
                <input value={fractionalTotalSupply} onChange={(e) => setFractionalTotalSupply(e.target.value)} required style={inputStyle} />
              </label>
              <label style={{ fontSize: 14 }}>
                Amount for sale
                <input value={fractionalAmountForSale} onChange={(e) => setFractionalAmountForSale(e.target.value)} required style={inputStyle} />
              </label>
              <label style={{ fontSize: 14 }}>
                Price / token (ETH)
                <input value={fractionalSalePrice} onChange={(e) => setFractionalSalePrice(e.target.value)} required style={inputStyle} />
              </label>
              <button style={buttonStyle} type="submit" disabled={busyAction === "fractionalize"}>
                {busyAction === "fractionalize" ? "Memproses..." : "Lock & split"}
              </button>
            </form>
          </div>

          <div style={cardStyle}>
            <h3 style={{ marginTop: 0 }}>3. Buy Fractions</h3>
            <form style={{ display: "grid", gap: 10 }} onSubmit={handleBuyFractions}>
              <label style={{ fontSize: 14 }}>
                Pool ID
                <input value={buyPoolId} onChange={(e) => setBuyPoolId(e.target.value)} required style={inputStyle} />
              </label>
              <label style={{ fontSize: 14 }}>
                Amount
                <input value={buyAmount} onChange={(e) => setBuyAmount(e.target.value)} required style={inputStyle} />
              </label>
              <button style={buttonStyle} type="submit" disabled={busyAction === "buy-fractions"}>
                {busyAction === "buy-fractions" ? "Membeli..." : "Buy fractions"}
              </button>
            </form>
          </div>
        </section>

        <section style={{ ...cardStyle, display: "grid", gap: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <h3 style={{ margin: 0 }}>Asset & Pool Status</h3>
            <button style={{ ...buttonStyle, padding: "8px 16px" }} onClick={refresh} disabled={loadingData}>
              Refresh
            </button>
          </div>
          {assets.length === 0 && <p style={{ color: "#94a3b8" }}>Belum ada asset terdaftar.</p>}
          <div style={{ display: "grid", gap: 12 }}>
            {assets.map((asset) => (
              <div key={asset.assetId} style={{ border: "1px solid #1e293b", borderRadius: 14, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
                  <div>
                    <strong>Asset #{asset.assetId}</strong> — royalty {(asset.royaltyBps / 100).toFixed(2)}%
                    <div style={{ fontSize: 13, color: "#94a3b8" }}>URI: {asset.metadataURI || "-"}</div>
                  </div>
                  <div style={{ fontSize: 13, textAlign: "right" }}>
                    Creator: {shorten(asset.creator)}
                    <br />
                    Owner: {shorten(asset.owner)}
                  </div>
                </div>
                {asset.pool ? (
                  <div style={{ marginTop: 12, padding: 12, borderRadius: 10, background: "#1e293b" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                      <div>
                        <strong>Pool #{asset.pool.poolId}</strong> — {asset.pool.active ? "Active" : "Closed"}
                        <div style={{ fontSize: 13, color: "#94a3b8" }}>
                          Sale {asset.pool.sold}/{asset.pool.amountForSale} | Price {asset.pool.salePriceEth} ETH/ft
                        </div>
                      </div>
                      <div style={{ fontSize: 13 }}>
                        Kamu punya: {asset.pool.userBalance} FT
                        <br />
                        Claimable: {asset.pool.claimableEth} ETH
                      </div>
                    </div>
                    <div style={{ marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
                      <button
                        style={smallButtonStyle}
                        onClick={() => handleClaim(asset.pool!.poolId)}
                        disabled={busyAction === `claim-${asset.pool.poolId}`}
                      >
                        {busyAction === `claim-${asset.pool.poolId}` ? "Claiming..." : "Claim dividend"}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p style={{ marginTop: 12, fontSize: 13, color: "#94a3b8" }}>Belum fractionalized.</p>
                )}
              </div>
            ))}
          </div>
        </section>

        <section style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))" }}>
          <div style={cardStyle}>
            <h3 style={{ marginTop: 0 }}>4. Create License Offer</h3>
            <form style={{ display: "grid", gap: 10 }} onSubmit={handleCreateOffer}>
              <label style={{ fontSize: 14 }}>
                Asset ID
                <input value={offerAssetId} onChange={(e) => setOfferAssetId(e.target.value)} required style={inputStyle} />
              </label>
              <label style={{ fontSize: 14 }}>
                Price (ETH)
                <input value={offerPrice} onChange={(e) => setOfferPrice(e.target.value)} required style={inputStyle} />
              </label>
              <label style={{ fontSize: 14 }}>
                Royalty bps
                <input
                  type="number"
                  value={offerRoyaltyBps}
                  onChange={(e) => setOfferRoyaltyBps(Number(e.target.value))}
                  min={0}
                  max={10000}
                  style={inputStyle}
                />
              </label>
              <label style={{ fontSize: 14 }}>
                License Type
                <select value={offerType} onChange={(e) => setOfferType(e.target.value)} style={{ ...inputStyle, background: "#020617" }}>
                  {licenseTypeLabels.map((label, idx) => (
                    <option key={label} value={idx}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ fontSize: 14 }}>
                Max supply (0 = unlimited)
                <input value={offerMaxSupply} onChange={(e) => setOfferMaxSupply(e.target.value)} style={inputStyle} />
              </label>
              <label style={{ fontSize: 14 }}>
                Duration detik (0 = permanent)
                <input value={offerDuration} onChange={(e) => setOfferDuration(e.target.value)} style={inputStyle} />
              </label>
              <label style={{ fontSize: 14 }}>
                License URI
                <input value={offerUri} onChange={(e) => setOfferUri(e.target.value)} required style={inputStyle} />
              </label>
              <button style={buttonStyle} type="submit" disabled={busyAction === "create-offer"}>
                {busyAction === "create-offer" ? "Menyimpan..." : "Create offer"}
              </button>
            </form>
          </div>

          <div style={cardStyle}>
            <h3 style={{ marginTop: 0 }}>5. Buy License</h3>
            <form style={{ display: "grid", gap: 10 }} onSubmit={handleBuyLicense}>
              <label style={{ fontSize: 14 }}>
                Offer ID
                <input value={buyOfferId} onChange={(e) => setBuyOfferId(e.target.value)} required style={inputStyle} />
              </label>
              <button style={buttonStyle} type="submit" disabled={busyAction === "buy-license"}>
                {busyAction === "buy-license" ? "Membeli..." : "Buy license"}
              </button>
            </form>
            <p style={{ fontSize: 12, color: "#94a3b8", marginTop: 12 }}>
              Gunakan daftar offer di bawah untuk memilih ID yang aktif, lalu masukkan di sini untuk membeli.
            </p>
          </div>
        </section>

        <section style={{ ...cardStyle, display: "grid", gap: 12 }}>
          <h3 style={{ margin: 0 }}>Live License Offers</h3>
          {offers.length === 0 && <p style={{ color: "#94a3b8" }}>Belum ada offer.</p>}
          <div style={{ display: "grid", gap: 12 }}>
            {offers.map((offer) => (
              <div key={offer.offerId} style={{ border: "1px solid #1e293b", borderRadius: 12, padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
                  <div>
                    <strong>Offer #{offer.offerId}</strong> — {licenseTypeLabels[offer.type]}
                    <div style={{ fontSize: 13, color: "#94a3b8" }}>
                      Asset #{offer.assetId} ({offer.assetUri || "no URI"}) | {offer.priceEth} ETH
                    </div>
                  </div>
                  <div style={{ fontSize: 13, textAlign: "right" }}>
                    Seller: {shorten(offer.seller)}
                    <br />
                    Status: {offer.active ? "Active" : "Inactive"}
                  </div>
                </div>
                <div style={{ fontSize: 13, marginTop: 6, color: "#cbd5f5" }}>
                  Supply: {offer.sold}/{offer.maxSupply || "∞"} | Royalty {offer.royaltyBps / 100}% | Duration:{" "}
                  {formatDuration(offer.duration)}
                </div>
                {offer.type === 1 && offer.exclusiveExpiry > 0 && (
                  <div style={{ fontSize: 12, marginTop: 4, color: "#fbbf24" }}>
                    Exclusive sampai: {new Date(offer.exclusiveExpiry * 1000).toLocaleString()}
                  </div>
                )}
                <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 6 }}>URI lisensi: {offer.uri}</div>
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}

const inputStyle: CSSProperties = {
  width: "100%",
  marginTop: 4,
  borderRadius: 10,
  border: "1px solid #1e293b",
  background: "#020617",
  color: "#f8fafc",
  padding: "8px 12px",
};

const buttonStyle: CSSProperties = {
  border: "none",
  borderRadius: 999,
  padding: "10px 0",
  fontWeight: 600,
  background: "#38bdf8",
  color: "#0f172a",
  cursor: "pointer",
};

const smallButtonStyle: CSSProperties = {
  ...buttonStyle,
  padding: "6px 18px",
  fontSize: 13,
};

function shorten(value: string) {
  if (!value) return "-";
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function formatDuration(seconds: number) {
  if (!seconds) return "permanent";
  if (seconds < 60) return `${seconds}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  return `${days.toFixed(1)}d`;
}

function extractError(err: unknown) {
  if (err instanceof Error && err.message) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

async function buildAssets(ctx: ContractInstances): Promise<AssetDisplay[]> {
  const totalAssets = Number(await ctx.assetRegistry.totalAssets());
  const list: AssetDisplay[] = [];
  for (let id = 1; id <= totalAssets; id++) {
    const raw = await ctx.assetRegistry.assets(id);
    if (!raw.exists) continue;

    let owner = "";
    try {
      const nft = new ethers.Contract(raw.nftContract, erc721Abi, ctx.provider);
      owner = await nft.ownerOf(raw.tokenId);
    } catch {
      owner = "unknown";
    }

    const poolId = await ctx.fractionalizer.assetToPool(id);
    let pool: PoolDisplay | undefined;
    if (poolId && poolId !== 0n) {
      const info = await ctx.fractionalizer.poolInfo(poolId);
      const claimable = await ctx.fractionalizer.claimableAmount(poolId, ctx.account);
      let balance = 0n;
      try {
        const ft = new ethers.Contract(info.ftAddress, erc20Abi, ctx.provider);
        balance = await ft.balanceOf(ctx.account);
      } catch {
        balance = 0n;
      }
      pool = {
        poolId: Number(poolId),
        active: info.active,
        salePriceEth: ethers.formatEther(info.salePricePerToken ?? 0n),
        amountForSale: Number(info.amountForSale),
        sold: Number(info.sold),
        totalFractions: Number(info.totalFractions),
        tokenId: Number(info.tokenId),
        ftAddress: info.ftAddress,
        claimableEth: ethers.formatEther(claimable ?? 0n),
        userBalance: balance.toString(),
        originalOwner: info.originalOwner,
      };
    }

    list.push({
      assetId: id,
      metadataURI: raw.metadataURI,
      royaltyBps: Number(raw.defaultRoyaltyBPS),
      tokenId: Number(raw.tokenId),
      nftContract: raw.nftContract,
      creator: raw.creator,
      owner,
      pool,
    });
  }
  return list;
}

async function buildOffers(ctx: ContractInstances, assetMap: Map<number, AssetDisplay>): Promise<OfferDisplay[]> {
  const total = Number(await ctx.licenseManager.totalOffers());
  const list: OfferDisplay[] = [];
  for (let oid = 1; oid <= total; oid++) {
    const raw = await ctx.licenseManager.offers(oid);
    if (!raw.offerId || raw.offerId === 0n) continue;
    const expiry = await ctx.licenseManager.exclusiveExpiry(raw.assetId);
    const asset = assetMap.get(Number(raw.assetId));
    list.push({
      offerId: oid,
      assetId: Number(raw.assetId),
      seller: raw.seller,
      priceEth: ethers.formatEther(raw.price ?? 0n),
      royaltyBps: Number(raw.royaltyBPS),
      type: Number(raw.ltype),
      maxSupply: Number(raw.maxSupply),
      sold: Number(raw.sold),
      duration: Number(raw.duration),
      active: raw.active,
      uri: raw.uri,
      assetUri: asset?.metadataURI,
      exclusiveExpiry: Number(expiry),
    });
  }
  return list;
}
