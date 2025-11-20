const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("GameAssetIP", function () {
  async function deployContract() {
    const GameAssetIP = await ethers.getContractFactory("GameAssetIP");
    const game = await GameAssetIP.deploy();
    await game.waitForDeployment();

    const [owner, buyer] = await ethers.getSigners();

    return { game, owner, buyer };
  }

  it("bisa mint aset dan owner-nya adalah minter", async function () {
    const { game, owner } = await deployContract();

    await game.mintAsset(
      "ipfs://dummy-uri",
      500,                              // 5% royalti
      ethers.parseEther("0.1")         // harga 0.1 ETH
    );

    const ownerOf0 = await game.ownerOf(0);
    expect(ownerOf0).to.equal(owner.address);
  });

  it("bisa dibeli oleh akun lain dan pindah kepemilikan", async function () {
    const { game, owner, buyer } = await deployContract();

    // owner bikin aset
    await game.mintAsset(
      "ipfs://dummy-uri",
      500,
      ethers.parseEther("0.1")
    );

    // buyer beli
    await game
      .connect(buyer)
      .buy(0, { value: ethers.parseEther("0.1") });

    const newOwner = await game.ownerOf(0);
    expect(newOwner).to.equal(buyer.address);
  });
});
