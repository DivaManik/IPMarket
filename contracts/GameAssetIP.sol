// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract GameAssetIP is ERC721URIStorage, Ownable, ReentrancyGuard {
    uint256 public nextId;

    // tokenId => price
    mapping(uint256 => uint256) public price;
    // tokenId => creator
    mapping(uint256 => address) public creator;
    // tokenId => royalty in basis points (1% = 100 bps)
    mapping(uint256 => uint96) public royaltyBps;

    event AssetMinted(uint256 indexed tokenId, address indexed creator, string uri);
    event AssetListed(uint256 indexed tokenId, uint256 price);
    event AssetSold(uint256 indexed tokenId, address indexed from, address indexed to, uint256 price);

    constructor() ERC721("GameAssetIP", "GIP") Ownable(msg.sender) {}

    function mintAsset(
        string memory uri,
        uint96 _royaltyBps,
        uint256 _price
    ) external {
        require(_royaltyBps <= 10_000, "royalty too high"); // max 100%

        uint256 tokenId = nextId;
        nextId += 1;

        _safeMint(msg.sender, tokenId);
        _setTokenURI(tokenId, uri);

        creator[tokenId] = msg.sender;
        royaltyBps[tokenId] = _royaltyBps;
        price[tokenId] = _price;

        emit AssetMinted(tokenId, msg.sender, uri);
        emit AssetListed(tokenId, _price);
    }

    function setPrice(uint256 tokenId, uint256 _price) external {
        require(ownerOf(tokenId) == msg.sender, "not owner");
        price[tokenId] = _price;
        emit AssetListed(tokenId, _price);
    }

    function buy(uint256 tokenId) external payable nonReentrant {
        uint256 p = price[tokenId];
        require(p > 0, "not for sale");
        require(msg.value >= p, "not enough");

        address seller = ownerOf(tokenId);
        require(seller != msg.sender, "you already own it");

        address assetCreator = creator[tokenId];
        uint256 royaltyAmount = (msg.value * royaltyBps[tokenId]) / 10_000;

        // 1. transfer NFT dulu (kalau ini gagal, ETH belum keluar)
        _transfer(seller, msg.sender, tokenId);

        // 2. bayar royalty ke creator (kalau ada)
        if (royaltyAmount > 0 && assetCreator != address(0)) {
            (bool okCreator, ) = payable(assetCreator).call{value: royaltyAmount}("");
            require(okCreator, "royalty transfer failed");
        }

        // 3. bayar sisanya ke seller
        uint256 sellerAmount = msg.value - royaltyAmount;
        (bool okSeller, ) = payable(seller).call{value: sellerAmount}("");
        require(okSeller, "seller transfer failed");

        emit AssetSold(tokenId, seller, msg.sender, msg.value);
    }
}
