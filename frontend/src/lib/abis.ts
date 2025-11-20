export const assetRegistryAbi = [
  "function registerAsset(string metadataURI, uint16 defaultRoyaltyBPS) returns (uint256)",
  "function assets(uint256 assetId) view returns (uint256 assetId, address creator, string metadataURI, uint16 defaultRoyaltyBPS, uint256 tokenId, address nftContract, bool exists)",
  "function assetNFT() view returns (address)",
  "function totalAssets() view returns (uint256)"
];

export const fractionalizerAbi = [
  "function fractionalize(uint256 assetId, address nftContract, uint256 tokenId, string name_, string symbol_, uint256 totalSupply_, uint256 salePricePerToken_, uint256 amountForSale_, address toReceiveInitial) returns (uint256)",
  "function assetToPool(uint256 assetId) view returns (uint256)",
  "function poolInfo(uint256 poolId) view returns (address nftContract, uint256 tokenId, address ftAddress, uint256 totalFractions, address originalOwner, uint256 salePricePerToken, uint256 amountForSale, uint256 sold, bool active, uint256 dividendsPerToken)",
  "function buyFractions(uint256 poolId, uint256 amount) payable",
  "function claimDividends(uint256 poolId)",
  "function claimableAmount(uint256 poolId, address holder) view returns (uint256)",
  "function recombineAndWithdraw(uint256 poolId)",
  "function totalPools() view returns (uint256)"
];

export const licenseManagerAbi = [
  "function createOffer(uint256 assetId, uint256 price, uint16 royaltyBPS, uint8 ltype, uint256 maxSupply, uint256 duration, string uri) returns (uint256)",
  "function buyLicense(uint256 offerId) payable returns (uint256)",
  "function cancelOffer(uint256 offerId)",
  "function offers(uint256 offerId) view returns (uint256 offerId, uint256 assetId, address seller, uint256 price, uint16 royaltyBPS, uint8 ltype, uint256 maxSupply, uint256 sold, uint256 duration, bool active, string uri)",
  "function totalOffers() view returns (uint256)",
  "function exclusiveExpiry(uint256 assetId) view returns (uint256)",
  "function licenseNft() view returns (address)"
];
