const hre = require("hardhat");

async function main() {
  const GameAssetIP = await hre.ethers.getContractFactory("GameAssetIP");

  // deploy kontraknya
  const gameAsset = await GameAssetIP.deploy();

  // tunggu sampai benar-benar ke-deploy
  await gameAsset.waitForDeployment();

  // ambil alamat kontraknya
  const address = await gameAsset.getAddress(); // atau: gameAsset.target

  console.log("GameAssetIP deployed to:", address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
