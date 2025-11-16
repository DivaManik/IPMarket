const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");

describe("IPFi Market stack", function () {
  async function deployFixture() {
    const [deployer, creator, buyer, attacker, licenseBuyer] = await ethers.getSigners();

    const AssetNFT = await ethers.getContractFactory("AssetNFT");
    const assetNft = await AssetNFT.deploy("Creator Asset", "CAS");
    await assetNft.waitForDeployment();

    const AssetRegistry = await ethers.getContractFactory("AssetRegistry");
    const assetRegistry = await AssetRegistry.deploy(await assetNft.getAddress());
    await assetRegistry.waitForDeployment();

    await assetNft.setRegistry(await assetRegistry.getAddress());

    const Fractionalizer = await ethers.getContractFactory("Fractionalizer");
    const fractionalizer = await Fractionalizer.deploy(await assetRegistry.getAddress());
    await fractionalizer.waitForDeployment();

    const LicenseNFT = await ethers.getContractFactory("LicenseNFT");
    const licenseNft = await LicenseNFT.deploy("License NFT", "LIC");
    await licenseNft.waitForDeployment();

    const LicenseManager = await ethers.getContractFactory("LicenseManager");
    const licenseManager = await LicenseManager.deploy(
      await assetRegistry.getAddress(),
      await licenseNft.getAddress(),
      await fractionalizer.getAddress()
    );
    await licenseManager.waitForDeployment();

    await licenseNft.setManager(await licenseManager.getAddress());

    return {
      deployer,
      creator,
      buyer,
      attacker,
      licenseBuyer,
      assetNft,
      assetRegistry,
      fractionalizer,
      licenseNft,
      licenseManager,
    };
  }

  async function registerAsset(assetRegistry, signer, uri, royaltyBps) {
    const tx = await assetRegistry.connect(signer).registerAsset(uri, royaltyBps);
    const receipt = await tx.wait();
    for (const log of receipt.logs) {
      try {
        const parsed = assetRegistry.interface.parseLog(log);
        if (parsed.name === "AssetRegistered") {
          return parsed.args.assetId;
        }
      } catch {
        // ignore logs from other contracts
      }
    }
    throw new Error("AssetRegistered event not emitted");
  }

  it("prevents mismatched fractionalization and resets mapping on recombine", async function () {
    const { assetRegistry, assetNft, fractionalizer, creator, attacker } = await loadFixture(deployFixture);

    const creatorAssetId = await registerAsset(assetRegistry, creator, "ipfs://asset-creator", 500);
    const attackerAssetId = await registerAsset(assetRegistry, attacker, "ipfs://asset-attacker", 400);

    const attackerAsset = await assetRegistry.assets(attackerAssetId);
    const attackerTokenId = attackerAsset.tokenId;
    await assetNft.connect(attacker).approve(await fractionalizer.getAddress(), attackerTokenId);

    await expect(
      fractionalizer.connect(attacker).fractionalize(
        creatorAssetId,
        await assetNft.getAddress(),
        attackerTokenId,
        "Attacker Fractions",
        "ATK",
        1000,
        ethers.parseEther("0.01"),
        100,
        attacker.address
      )
    ).to.be.revertedWith("asset mismatch");

    const creatorAsset = await assetRegistry.assets(creatorAssetId);
    const creatorTokenId = creatorAsset.tokenId;
    await assetNft.connect(creator).approve(await fractionalizer.getAddress(), creatorTokenId);

    await fractionalizer.connect(creator).fractionalize(
      creatorAssetId,
      await assetNft.getAddress(),
      creatorTokenId,
      "Creator Fractions",
      "CFT",
      1000,
      ethers.parseEther("0.005"),
      200,
      creator.address
    );

    const poolId = await fractionalizer.assetToPool(creatorAssetId);
    expect(poolId).to.not.equal(0n);
    expect(await assetNft.ownerOf(creatorTokenId)).to.equal(await fractionalizer.getAddress());

    const poolInfo = await fractionalizer.poolInfo(poolId);
    const fractionalToken = await ethers.getContractAt("FractionalToken", poolInfo.ftAddress);
    await fractionalToken.connect(creator).approve(await fractionalizer.getAddress(), poolInfo.totalFractions);

    await fractionalizer.connect(creator).recombineAndWithdraw(poolId);

    expect(await assetNft.ownerOf(creatorTokenId)).to.equal(creator.address);
    expect(await fractionalizer.assetToPool(creatorAssetId)).to.equal(0n);
  });

  it("routes license payments to fraction holders", async function () {
    const { assetRegistry, assetNft, fractionalizer, licenseManager, licenseNft, creator, buyer, licenseBuyer } =
      await loadFixture(deployFixture);

    const assetId = await registerAsset(assetRegistry, creator, "ipfs://asset-license", 800);
    const asset = await assetRegistry.assets(assetId);
    const tokenId = asset.tokenId;
    await assetNft.connect(creator).approve(await fractionalizer.getAddress(), tokenId);

    const totalFractions = 1000n;
    const amountForSale = 400n;
    const salePricePerToken = ethers.parseEther("0.001");
    await fractionalizer.connect(creator).fractionalize(
      assetId,
      await assetNft.getAddress(),
      tokenId,
      "Game Fraction",
      "GFN",
      totalFractions,
      salePricePerToken,
      amountForSale,
      creator.address
    );

    const poolId = await fractionalizer.assetToPool(assetId);
    const poolInfo = await fractionalizer.poolInfo(poolId);
    const fractionalToken = await ethers.getContractAt("FractionalToken", poolInfo.ftAddress);
    await fractionalToken.connect(creator).approve(await fractionalizer.getAddress(), amountForSale);

    const buyerAmount = 200n;
    const cost = salePricePerToken * buyerAmount;
    await fractionalizer.connect(buyer).buyFractions(poolId, buyerAmount, { value: cost });

    const licensePrice = ethers.parseEther("1");
    const createTx = await licenseManager.connect(creator).createOffer(
      assetId,
      licensePrice,
      0,
      0,
      0,
      0,
      "ipfs://license"
    );
    const createReceipt = await createTx.wait();
    let offerId;
    for (const log of createReceipt.logs) {
      try {
        const parsed = licenseManager.interface.parseLog(log);
        if (parsed.name === "LicenseOfferCreated") {
          offerId = parsed.args.offerId;
          break;
        }
      } catch {
        // ignore
      }
    }
    if (!offerId) {
      throw new Error("LicenseOfferCreated not emitted");
    }

    await licenseManager.connect(licenseBuyer).buyLicense(offerId, { value: licensePrice });
    expect(await licenseNft.ownerOf(1n)).to.equal(licenseBuyer.address);

    const creatorExpected = (licensePrice * (totalFractions - buyerAmount)) / totalFractions;
    const buyerExpected = (licensePrice * buyerAmount) / totalFractions;

    expect(await fractionalizer.claimableAmount(poolId, creator.address)).to.equal(creatorExpected);
    expect(await fractionalizer.claimableAmount(poolId, buyer.address)).to.equal(buyerExpected);

    await expect(() => fractionalizer.connect(creator).claimDividends(poolId)).to.changeEtherBalances(
      [creator, fractionalizer],
      [creatorExpected, -creatorExpected]
    );

    await expect(() => fractionalizer.connect(buyer).claimDividends(poolId)).to.changeEtherBalances(
      [buyer, fractionalizer],
      [buyerExpected, -buyerExpected]
    );

    expect(await fractionalizer.claimableAmount(poolId, creator.address)).to.equal(0);
    expect(await fractionalizer.claimableAmount(poolId, buyer.address)).to.equal(0);
  });
});
