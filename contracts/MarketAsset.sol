// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/*
IPFi MVP Smart Contracts (REVISED)
- AssetNFT: ERC721 for asset ownership
- AssetRegistry: register assets, mint AssetNFT
- FractionalToken: ERC20 (burnable) representing fractional ownership
- Fractionalizer: lock NFT -> mint FT, manage sale, distribute royalties to FT holders (pull)
- LicenseNFT: ERC721 for license evidence
- LicenseManager: create license offers, sell licenses, forward payments to Fractionalizer pool
Notes:
- For demo/hackathon only. Add audits, oracle integration for off-chain revenue, KYC, upgradability for production.
*/

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

library Counters {
    struct Counter {
        uint256 _value;
    }

    function current(Counter storage counter) internal view returns (uint256) {
        return counter._value;
    }

    function increment(Counter storage counter) internal {
        unchecked {
            counter._value += 1;
        }
    }
}

/* ---------------- Asset NFT ---------------- */
contract AssetNFT is ERC721URIStorage, Ownable {
    using Counters for Counters.Counter;
    Counters.Counter private _tokenIds;
    address public registry;

    modifier onlyRegistry() {
        require(msg.sender == registry, "Only registry");
        _;
    }

    constructor(string memory name_, string memory symbol_) ERC721(name_, symbol_) Ownable(msg.sender) {
        // NOTE: for production, prefer passing registry in constructor
        registry = msg.sender;
    }

    function setRegistry(address _r) external onlyOwner {
        registry = _r;
    }

    function mintFor(address to, string calldata tokenURI_) external onlyRegistry returns (uint256) {
        _tokenIds.increment();
        uint256 id = _tokenIds.current();
        _mint(to, id);
        _setTokenURI(id, tokenURI_);
        return id;
    }
}

/* ---------------- Fractional Token ---------------- */
contract FractionalToken is ERC20, ERC20Burnable {
    address public fractionalizer;
    uint256 public originAssetId; // for reference (e.g. AssetNFT tokenId)

    modifier onlyFractionalizer() {
        require(msg.sender == fractionalizer, "Only fractionalizer");
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 totalSupply_,
        address to_,
        address fractionalizer_,
        uint256 assetId_
    ) ERC20(name_, symbol_) {
        fractionalizer = fractionalizer_;
        originAssetId = assetId_;
        _mint(to_, totalSupply_);
    }

    // optional: allow fractionalizer to mint more (not used here)
    function mintByFractionalizer(address to, uint256 amount) external onlyFractionalizer {
        _mint(to, amount);
    }
}

/* ---------------- Asset Registry ---------------- */
contract AssetRegistry is Ownable, ReentrancyGuard {
    using Counters for Counters.Counter;
    Counters.Counter private _assetCounter;

    struct Asset {
        uint256 assetId;
        address creator;
        string metadataURI;
        uint16 defaultRoyaltyBPS; // out of 10,000
        uint256 tokenId; // AssetNFT token id
        address nftContract;
        bool exists;
    }

    mapping(uint256 => Asset) public assets;
    AssetNFT public assetNFT;

    event AssetRegistered(
        uint256 indexed assetId,
        address indexed creator,
        address nftContract,
        uint256 tokenId,
        string metadataURI,
        uint16 royaltyBPS
    );

    constructor(address _assetNft) Ownable(msg.sender) {
        assetNFT = AssetNFT(_assetNft);
    }

    function registerAsset(string calldata metadataURI, uint16 defaultRoyaltyBPS)
        external
        nonReentrant
        returns (uint256)
    {
        require(defaultRoyaltyBPS <= 10000, "royalty>100%");
        _assetCounter.increment();
        uint256 aid = _assetCounter.current();

        // mint an AssetNFT to creator via AssetNFT (registry must be set as minter)
        uint256 tokenId = assetNFT.mintFor(msg.sender, metadataURI);

        assets[aid] = Asset({
            assetId: aid,
            creator: msg.sender,
            metadataURI: metadataURI,
            defaultRoyaltyBPS: defaultRoyaltyBPS,
            tokenId: tokenId,
            nftContract: address(assetNFT),
            exists: true
        });

        emit AssetRegistered(aid, msg.sender, address(assetNFT), tokenId, metadataURI, defaultRoyaltyBPS);
        return aid;
    }

    function getAsset(uint256 assetId) external view returns (Asset memory) {
        return assets[assetId];
    }

    function totalAssets() external view returns (uint256) {
        return _assetCounter.current();
    }
}

/* ---------------- Fractionalizer ----------------
 - Locks NFT (transferFrom owner -> this)
 - Deploys FractionalToken (ERC20) with totalSupply minted to toReceiveInitial
 - Records a pool per assetId
 - Supports initial sale (simple fixed price)
 - Receives royalty deposits (payable) from LicenseManager and updates dividendsPerToken
 - Allows holders to claim dividends proportional to their balance (pull)
 - Allows recombine: holder owning full supply can burn and withdraw NFT back
*/
contract Fractionalizer is Ownable, ReentrancyGuard {
    using Counters for Counters.Counter;
    Counters.Counter private _poolCounter;
    AssetRegistry public immutable registry;

    struct Pool {
        uint256 poolId;
        uint256 assetId;
        address nftContract;
        uint256 tokenId;
        address ftAddress; // fractional token
        uint256 totalFractions;
        address originalOwner;      // initial FT holder (seller in primary sale)
        uint256 salePricePerToken;  // in wei
        uint256 amountForSale;      // how many tokens available in initial sale
        uint256 sold;               // sold so far
        bool active;
        // dividend tracking
        uint256 dividendsPerToken; // scaled by 1e18
        mapping(address => uint256) withdrawn; // withdrawn amount per holder (in wei)
    }

    constructor(address registry_) Ownable(msg.sender) {
        require(registry_ != address(0), "invalid registry");
        registry = AssetRegistry(registry_);
    }

    // poolId => Pool
    mapping(uint256 => Pool) private pools;
    // assetId -> poolId (set automatically in fractionalize)
    mapping(uint256 => uint256) public assetToPool;

    event Fractionalized(
        uint256 indexed poolId,
        uint256 indexed assetId,
        address indexed ft,
        address owner,
        uint256 totalSupply,
        uint256 salePricePerToken,
        uint256 amountForSale
    );
    event FractionsBought(uint256 indexed poolId, address buyer, uint256 amount, uint256 paid);
    event DividendsDeposited(uint256 indexed poolId, address from, uint256 amount);
    event DividendClaimed(uint256 indexed poolId, address claimer, uint256 amount);
    event Recombined(uint256 indexed poolId, address claimer);

    /**
     * @dev fractionalize an asset:
     * - assetId: id from AssetRegistry (used for mapping & events)
     * - nftContract/tokenId: actual NFT to lock
     * - FT params: name/symbol/totalSupply
     * - sale params: price per FT & amountForSale
     * - toReceiveInitial: address that receives minted FTs (becomes originalOwner)
     */
    function fractionalize(
        uint256 assetId,
        address nftContract,
        uint256 tokenId,
        string calldata name_,
        string calldata symbol_,
        uint256 totalSupply_,
        uint256 salePricePerToken_,
        uint256 amountForSale_,
        address toReceiveInitial // who gets initial minted tokens (usually creator)
    ) external nonReentrant returns (uint256) {
        require(assetId != 0, "invalid assetId");
        require(totalSupply_ > 0, "totalSupply>0");
        require(amountForSale_ <= totalSupply_, "invalid sale amount");
        require(toReceiveInitial != address(0), "invalid receiver");
        require(assetToPool[assetId] == 0, "asset already fractionalized");

        AssetRegistry.Asset memory asset = registry.getAsset(assetId);
        require(asset.exists, "asset not found");
        require(asset.nftContract == nftContract && asset.tokenId == tokenId, "asset mismatch");

        // Transfer NFT into custody
        ERC721 nft = ERC721(nftContract);
        require(nft.ownerOf(tokenId) == msg.sender, "not nft owner");
        // Caller must approve this contract
        nft.transferFrom(msg.sender, address(this), tokenId);

        // Deploy FractionalToken and mint totalSupply_ to toReceiveInitial
        FractionalToken ft = new FractionalToken(
            name_,
            symbol_,
            totalSupply_,
            toReceiveInitial,
            address(this),
            tokenId
        );

        _poolCounter.increment();
        uint256 pid = _poolCounter.current();

        Pool storage p = pools[pid];
        p.poolId = pid;
        p.assetId = assetId;
        p.nftContract = nftContract;
        p.tokenId = tokenId;
        p.ftAddress = address(ft);
        p.totalFractions = totalSupply_;
        p.originalOwner = toReceiveInitial;  // seller in primary sale
        p.salePricePerToken = salePricePerToken_;
        p.amountForSale = amountForSale_;
        p.sold = 0;
        p.active = true;
        p.dividendsPerToken = 0;

        // map assetId -> poolId automatically
        assetToPool[assetId] = pid;

        emit Fractionalized(
            pid,
            assetId,
            address(ft),
            toReceiveInitial,
            totalSupply_,
            salePricePerToken_,
            amountForSale_
        );
        return pid;
    }

    // Optional manual override if needed by owner
    function setAssetPool(uint256 assetId, uint256 poolId) external onlyOwner {
        assetToPool[assetId] = poolId;
    }

    // Buy fractions during initial sale (simple fixed-price primary sale)
    function buyFractions(uint256 poolId, uint256 amount) external payable nonReentrant {
        Pool storage p = pools[poolId];
        require(p.active, "pool inactive");
        require(amount > 0 && p.sold + amount <= p.amountForSale, "not enough for sale");
        require(p.salePricePerToken > 0, "sale price not set");

        uint256 cost = p.salePricePerToken * amount;
        require(msg.value == cost, "incorrect payment");

        FractionalToken ft = FractionalToken(p.ftAddress);

        // initial FT holder (originalOwner = toReceiveInitial) acts as seller
        address seller = p.originalOwner;
        require(ft.allowance(seller, address(this)) >= amount, "seller must approve");
        bool ok = ft.transferFrom(seller, msg.sender, amount);
        require(ok, "ft transfer failed");

        p.sold += amount;

        // forward payment to seller (creator/owner)
        (bool sent, ) = payable(seller).call{value: msg.value}("");
        require(sent, "payment transfer failed");

        emit FractionsBought(poolId, msg.sender, amount, msg.value);
    }

    // Dividends: accept royalty deposits for a pool (from LicenseManager)
    receive() external payable {
        revert("use depositToPool");
    }

    function depositToPool(uint256 poolId) external payable nonReentrant {
        require(msg.value > 0, "no funds");
        Pool storage p = pools[poolId];
        require(p.active, "pool inactive");
        require(p.totalFractions > 0, "no fractions");

        // increase dividendsPerToken scaled by 1e18
        p.dividendsPerToken += (msg.value * 1e18) / p.totalFractions;

        emit DividendsDeposited(poolId, msg.sender, msg.value);
    }

    // claim dividends for a holder for a given pool
    function claimDividends(uint256 poolId) external nonReentrant {
        Pool storage p = pools[poolId];
        require(p.active, "pool inactive");
        FractionalToken ft = FractionalToken(p.ftAddress);
        uint256 bal = ft.balanceOf(msg.sender);
        require(bal > 0, "no balance");

        uint256 totalEntitled = (bal * p.dividendsPerToken) / 1e18;
        uint256 already = p.withdrawn[msg.sender];
        require(totalEntitled > already, "nothing to claim");
        uint256 amount = totalEntitled - already;
        p.withdrawn[msg.sender] = totalEntitled;

        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "transfer failed");

        emit DividendClaimed(poolId, msg.sender, amount);
    }

    // view available claim for holder
    function claimableAmount(uint256 poolId, address holder) external view returns (uint256) {
        Pool storage p = pools[poolId];
        FractionalToken ft = FractionalToken(p.ftAddress);
        uint256 bal = ft.balanceOf(holder);
        uint256 totalEntitled = (bal * p.dividendsPerToken) / 1e18;
        uint256 already = p.withdrawn[holder];
        if (totalEntitled <= already) return 0;
        return totalEntitled - already;
    }

    // recombine: holder owning full supply can burn & withdraw NFT
    function recombineAndWithdraw(uint256 poolId) external nonReentrant {
        Pool storage p = pools[poolId];
        require(p.active, "pool inactive");

        FractionalToken ft = FractionalToken(p.ftAddress);
        uint256 bal = ft.balanceOf(msg.sender);
        require(bal == p.totalFractions, "must own all fractions");

        // holder must approve this contract for burning
        ft.burnFrom(msg.sender, bal); // requires allowance to this contract

        // transfer NFT back to msg.sender
        ERC721 nft = ERC721(p.nftContract);
        nft.transferFrom(address(this), msg.sender, p.tokenId);

        p.active = false; // pool closed
        if (p.assetId != 0 && assetToPool[p.assetId] == poolId) {
            assetToPool[p.assetId] = 0;
        }
        emit Recombined(poolId, msg.sender);
    }

    // expose some getters
    function poolInfo(uint256 poolId)
        external
        view
        returns (
            address nftContract,
            uint256 tokenId,
            address ftAddress,
            uint256 totalFractions,
            address originalOwner,
            uint256 salePricePerToken,
            uint256 amountForSale,
            uint256 sold,
            bool active,
            uint256 dividendsPerToken
        )
    {
        Pool storage p = pools[poolId];
        nftContract = p.nftContract;
        tokenId = p.tokenId;
        ftAddress = p.ftAddress;
        totalFractions = p.totalFractions;
        originalOwner = p.originalOwner;
        salePricePerToken = p.salePricePerToken;
        amountForSale = p.amountForSale;
        sold = p.sold;
        active = p.active;
        dividendsPerToken = p.dividendsPerToken;
    }

    function totalPools() external view returns (uint256) {
        return _poolCounter.current();
    }
}

/* ---------------- License NFT ---------------- */
contract LicenseNFT is ERC721URIStorage, Ownable {
    using Counters for Counters.Counter;
    Counters.Counter private _licenseIds;
    address public manager;

    modifier onlyManager() {
        require(msg.sender == manager, "Only manager");
        _;
    }

    constructor(string memory name_, string memory symbol_) ERC721(name_, symbol_) Ownable(msg.sender) {
        // NOTE: for production, pass manager in constructor
        manager = msg.sender;
    }

    function setManager(address _m) external onlyOwner {
        manager = _m;
    }

    function mintLicense(address to, string calldata uri) external onlyManager returns (uint256) {
        _licenseIds.increment();
        uint256 id = _licenseIds.current();
        _mint(to, id);
        _setTokenURI(id, uri);
        return id;
    }
}

/* ---------------- License Manager ----------------
 - create license offers linked to assetId
 - supports EXCLUSIVE / NON_EXCLUSIVE / DERIVATIVE
 - sells license -> mints LicenseNFT to buyer
 - forwards funds to Fractionalizer.depositToPool(assetPoolId) if fractionalized
 - tracks exclusive locks & expiry times
*/
contract LicenseManager is Ownable, ReentrancyGuard {
    using Counters for Counters.Counter;
    Counters.Counter private _offerCounter;

    enum LicenseType { NON_EXCLUSIVE, EXCLUSIVE, DERIVATIVE }

    struct Offer {
        uint256 offerId;
        uint256 assetId;
        address seller;
        uint256 price; // wei
        uint16 royaltyBPS; // royalties on resale (optional / future use)
        LicenseType ltype;
        uint256 maxSupply; // 0 = unlimited for non-exclusive, 1 for exclusive
        uint256 sold;
        uint256 duration; // seconds (0 = permanent)
        bool active;
        string uri; // license metadata
    }

    mapping(uint256 => Offer) public offers;

    // track exclusive lock per assetId
    mapping(uint256 => uint256) public exclusiveExpiry; // timestamp when exclusive lock ends (0 if none)

    // references
    AssetRegistry public registry;
    LicenseNFT public licenseNft;
    Fractionalizer public fractionalizer;

    event LicenseOfferCreated(
        uint256 indexed offerId,
        uint256 indexed assetId,
        address seller,
        uint256 price,
        LicenseType ltype,
        uint256 maxSupply
    );
    event LicensePurchased(uint256 indexed offerId, uint256 indexed licenseTokenId, address buyer, uint256 price);

    constructor(address _assetRegistry, address _licenseNft, address _fractionalizer) Ownable(msg.sender) {
        registry = AssetRegistry(_assetRegistry);
        licenseNft = LicenseNFT(_licenseNft);
        fractionalizer = Fractionalizer(payable(_fractionalizer));
    }

    function createOffer(
        uint256 assetId,
        uint256 price,
        uint16 royaltyBPS,
        LicenseType ltype,
        uint256 maxSupply,
        uint256 duration,
        string calldata uri
    ) external returns (uint256) {
        // check asset exists
        AssetRegistry.Asset memory a = registry.getAsset(assetId);
        require(a.exists, "asset not found");

        // only creator or current NFT owner can create offers
        address currentOwner = ERC721(a.nftContract).ownerOf(a.tokenId);
        require(
            msg.sender == a.creator || msg.sender == currentOwner,
            "not creator/owner"
        );

        // For EXCLUSIVE: ensure no active exclusive lock
        if (ltype == LicenseType.EXCLUSIVE) {
            require(block.timestamp >= exclusiveExpiry[assetId], "exclusive active");
        }

        _offerCounter.increment();
        uint256 oid = _offerCounter.current();

        offers[oid] = Offer({
            offerId: oid,
            assetId: assetId,
            seller: msg.sender,
            price: price,
            royaltyBPS: royaltyBPS,
            ltype: ltype,
            maxSupply: maxSupply,
            sold: 0,
            duration: duration,
            active: true,
            uri: uri
        });

        emit LicenseOfferCreated(oid, assetId, msg.sender, price, ltype, maxSupply);
        return oid;
    }

    // buy license: mints LicenseNFT and forwards payment to fractionalizer pool (if exists)
    function buyLicense(uint256 offerId) external payable nonReentrant returns (uint256) {
        Offer storage o = offers[offerId];
        require(o.active, "not active");
        require(msg.value >= o.price, "insufficient pay");

        // supply check for non-exclusive with maxSupply >0
        if (o.maxSupply > 0) {
            require(o.sold < o.maxSupply, "sold out");
        }

        // if exclusive: ensure not already active
        if (o.ltype == LicenseType.EXCLUSIVE) {
            require(block.timestamp >= exclusiveExpiry[o.assetId], "exclusive active");
            // set exclusive expiry based on duration
            if (o.duration > 0) {
                exclusiveExpiry[o.assetId] = block.timestamp + o.duration;
            } else {
                // permanent exclusive -> set very large timestamp
                exclusiveExpiry[o.assetId] = type(uint256).max;
            }
        }

        // mint license NFT to buyer
        uint256 licenseTokenId = licenseNft.mintLicense(msg.sender, o.uri);

        o.sold += 1;
        // If maxSupply == 1 (exclusive), we can deactivate
        if (o.maxSupply == 1) {
            o.active = false;
        }

        // Forward payment to fractionalizer pool if exists for this asset (else send to seller)
        uint256 poolId = fractionalizer.assetToPool(o.assetId);
        if (poolId != 0) {
            // forward funds to fractionalizer pool (acts as treasury for this asset)
            (bool ok, ) = address(fractionalizer).call{value: o.price}(
                abi.encodeWithSignature("depositToPool(uint256)", poolId)
            );
            require(ok, "deposit failed");
        } else {
            // send to seller directly
            (bool sent, ) = payable(o.seller).call{value: o.price}("");
            require(sent, "seller transfer failed");
        }

        // refund overflow
        if (msg.value > o.price) {
            (bool r, ) = payable(msg.sender).call{value: msg.value - o.price}("");
            require(r, "refund failed");
        }

        emit LicensePurchased(offerId, licenseTokenId, msg.sender, o.price);
        return licenseTokenId;
    }

    // allow owner or seller to cancel offer
    function cancelOffer(uint256 offerId) external {
        Offer storage o = offers[offerId];
        require(msg.sender == o.seller || msg.sender == owner(), "not authorized");
        o.active = false;
    }

    function totalOffers() external view returns (uint256) {
        return _offerCounter.current();
    }
}
