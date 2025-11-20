import { ethers } from "ethers";
import { assetRegistryAbi, fractionalizerAbi, licenseManagerAbi } from "./abis";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const HARDHAT_CHAIN_ID = 31337;

export const CONTRACT_ADDRESSES = {
  assetRegistry:  "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
  fractionalizer: "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
  licenseManager: "0x5FC8d32690cc91D4c39d9d3abcBD16989F875707",
};

export type ContractInstances = {
  provider: ethers.BrowserProvider;
  signer: ethers.JsonRpcSigner;
  account: string;
  assetRegistry: ethers.Contract;
  fractionalizer: ethers.Contract;
  licenseManager: ethers.Contract;
  addresses: typeof CONTRACT_ADDRESSES;
};

function ensureAddress(address: string, label: string) {
  if (!address || address === ZERO_ADDRESS) {
    throw new Error(
      `Alamat ${label} belum diatur. Edit CONTRACT_ADDRESSES di src/lib/contract.ts atau set NEXT_PUBLIC_${label
        .replace(/([A-Z])/g, "_$1")
        .toUpperCase()} di .env.local`
    );
  }
}

export async function connectContracts(): Promise<ContractInstances> {
  if (typeof window === "undefined") {
    throw new Error("window tidak tersedia");
  }

  const { ethereum } = window as typeof window & { ethereum?: any };
  if (!ethereum) {
    throw new Error("MetaMask tidak ditemukan");
  }

  const provider = new ethers.BrowserProvider(ethereum);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const account = await signer.getAddress();
  const network = await provider.getNetwork();

  if (Number(network.chainId) !== HARDHAT_CHAIN_ID) {
    throw new Error(
      `Network salah. Sambungkan MetaMask ke Hardhat local (chainId 31337). Saat ini: ${network.chainId.toString()}`
    );
  }

  const addresses = { ...CONTRACT_ADDRESSES };
  ensureAddress(addresses.assetRegistry, "assetRegistry");
  ensureAddress(addresses.fractionalizer, "fractionalizer");
  ensureAddress(addresses.licenseManager, "licenseManager");

  const assetRegistry = new ethers.Contract(addresses.assetRegistry, assetRegistryAbi, signer);
  const fractionalizer = new ethers.Contract(addresses.fractionalizer, fractionalizerAbi, signer);
  const licenseManager = new ethers.Contract(addresses.licenseManager, licenseManagerAbi, signer);

  return {
    provider,
    signer,
    account,
    assetRegistry,
    fractionalizer,
    licenseManager,
    addresses,
  };
}

export const erc721Abi = [
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function tokenURI(uint256 tokenId) view returns (string)",
  "function approve(address to, uint256 tokenId)",
  "function getApproved(uint256 tokenId) view returns (address)",
];

export const erc20Abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
];
