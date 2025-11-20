const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const AssetNFT = await hre.ethers.getContractFactory("AssetNFT");
  const assetNft = await AssetNFT.deploy("Creator Asset", "CAS");
  await assetNft.waitForDeployment();
  console.log("AssetNFT:", await assetNft.getAddress());

  const AssetRegistry = await hre.ethers.getContractFactory("AssetRegistry");
  const assetRegistry = await AssetRegistry.deploy(await assetNft.getAddress());
  await assetRegistry.waitForDeployment();
  await assetNft.setRegistry(await assetRegistry.getAddress());
  console.log("AssetRegistry:", await assetRegistry.getAddress());

  const Fractionalizer = await hre.ethers.getContractFactory("Fractionalizer");
  const fractionalizer = await Fractionalizer.deploy(await assetRegistry.getAddress());
  await fractionalizer.waitForDeployment();
  console.log("Fractionalizer:", await fractionalizer.getAddress());

  const LicenseNFT = await hre.ethers.getContractFactory("LicenseNFT");
  const licenseNft = await LicenseNFT.deploy("License NFT", "LIC");
  await licenseNft.waitForDeployment();
  console.log("LicenseNFT:", await licenseNft.getAddress());

  const LicenseManager = await hre.ethers.getContractFactory("LicenseManager");
  const licenseManager = await LicenseManager.deploy(
    await assetRegistry.getAddress(),
    await licenseNft.getAddress(),
    await fractionalizer.getAddress()
  );
  await licenseManager.waitForDeployment();
  await licenseNft.setManager(await licenseManager.getAddress());
  console.log("LicenseManager:", await licenseManager.getAddress());

  console.log("\nSet these addresses in your frontend or .env:");
  console.log("NEXT_PUBLIC_ASSET_REGISTRY =", await assetRegistry.getAddress());
  console.log("NEXT_PUBLIC_FRACTIONALIZER =", await fractionalizer.getAddress());
  console.log("NEXT_PUBLIC_LICENSE_MANAGER =", await licenseManager.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
