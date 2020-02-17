const cTokens = require('../contracts/cTokens')
const comptrollerContract = require('../contracts/comptrollerContract')
const priceOracleContract = require('../contracts/priceOracleContract')
const aaveContract = require('../contracts/aave')
const uniswapContracts = require('../contracts/uniswap')
const Web3 = require('web3')
const net = require('net')
const logger = require('tracer').console()
const bigNumber = require('bignumber.js')
const uniswap = require('@uniswap/sdk')

const local = "ws://127.0.0.1:8546"
const infura = "wss://mainnet.infura.io/ws/v3/1e6dafd39f064e1cb74ca7e7115ef345"
const ipc = new Web3.providers.IpcProvider("/home/belvis/.ethereum/geth.ipc", net)
const startingBlock = 7722506 //when the first compound contract deployed 
const provider = new Web3(infura, net)
const web3 = new Web3(provider)

const comptroller = new web3.eth.Contract(comptrollerContract.abi, comptrollerContract.address)
const priceOracle = new web3.eth.Contract(priceOracleContract.abi, priceOracleContract.address)
const aave = new web3.eth.Contract(aaveContract.abi, aaveContract.address)
const uniswapFactory = new web3.eth.Contract(uniswapContracts.factoryABI, uniswapContracts.factoryAddress)
const flashLoanRate = 35 //the flash loan rate in basis points -- flash loan fee is always 35 basis points as far as i can tell



//~~~~~~~~~~~~~~~~~~~~~~~~~~~init state vars~~~~~~~~~~~~~~~~~~~~~~~~~~~~

cTokenAddresses = []
cTokenContracts = {}
var tokenData = {}


cTokens.entries().forEach(cToken => {
  
  cTokenAddresses.push(cToken.address)
  cTokenContracts[cToken.address] = new web3.eth.Contract(cToken.abi, cToken.address)
  tokenData[cToken.address] = {
    underlyingAddress : cToken.underlyingAddress,
    underlyingPriceInEth : null,
    exchangeRate : null,
    flashLoanLiquidity : null
  }
})
var closeFactor = null
var liquidationIncentive = null



syncData = async () => {
  logger.debug('started syncData()')
  var promises = []
  
  promises.push(comptroller.methods.closeFactorMantissa().call().then(result => {
    var asBigNumber = new bigNumber(result)
    closeFactor = asBigNumber.shiftedBy(-18)
  }))
  promises.push(comptroller.methods.liquidationIncentiveMantissa().call().then(result => {
    var asBigNumber = new bigNumber(result)
    liquidationIncentive = asBigNumber.shiftedBy(-18)
  }))
  cTokenAddresses.forEach(address => {
    promises.push(syncCToken(address))
  })
  Promise.all(promises).then(getUniswapReserves)
  .then(() => {
    return
  })
  .catch((err) => console.log(err))
}

syncCToken = cTokenAddress => {
  return new Promise((resolve,reject) => {
    const underlyingAddress = tokenData[cTokenAddress].underlyingAddress

    var promises = []
    promises.push(priceOracle.methods.getUnderlyingPrice(cTokenAddress).call().then(price => {
      tokenData[cTokenAddress].underlyingPriceInEth = new bigNumber(price).shiftedBy(-18)
      //console.log(tokenData[cTokenAddress].underlyingPriceInEth.toString())
    }))
    promises.push(cTokenContracts[cTokenAddress].methods.exchangeRateCurrent().call().then(rate => {
      tokenData[cTokenAddress].exchangeRate = new bigNumber(rate).shiftedBy(-18)
      //console.log(tokenData[cTokenAddress].exchangeRate.toString())
    }))
    var reserveData
    promises.push(aave.methods.getReserveData(underlyingAddress).call().then(data => {
      reserveData = new bigNumber(data.availableLiquidity)
      //console.log(reserveData.toString())
    }))
  
    Promise.all(promises)
    .then(() => {
      tokenData[cTokenAddress].flashLoanLiquidity = reserveData
      resolve()
    })
    .catch(reject)
  })
}


getLargestBorrow = address => {
  return new Promise((resolve, reject) => {
    var promises = []
    cTokenAddresses.forEach(cTokenAddress => {
      promises.push(cTokenContracts[cTokenAddress].methods.borrowBalanceCurrent(address).call().then(borrow => {
        return [borrow, cTokenAddress]
      }))
    })

    Promise.all(promises).then(borrows => {
      var largestEthVal = new bigNumber(0)
      var largestTokenBalance
      var assetCTokenAddress
      borrows.forEach(borrow => {
        //each borrow is an array: [tokensBorrowed, cTokenAddress]
        //logger.debug(borrow[0], tokenData[borrow[1]].underlyingPriceInEth.toString(), borrow[1])
        var borrowed = new bigNumber(borrow[0])
        var underlying = new bigNumber(tokenData[borrow[1]].underlyingPriceInEth)
        var ethVal = borrowed.times(underlying)
        //console.log(ethVal.toString())
        if(ethVal.isGreaterThan(largestEthVal)){
          largestEthVal = ethVal
          largestTokenBalance = borrowed
          assetCTokenAddress = borrow[1]
        }
      })
      //logger.debug(largestTokenBalance, assetCTokenAddress, largestEthVal.toString())
      resolve([largestTokenBalance, assetCTokenAddress, largestEthVal])
    })
    .catch(reject)
  })
}

getLargestCollateral = address => {//TODO THIS IS NOT WORKING PROPERLY
  return new Promise((resolve, reject) => {
    var promises = []
    cTokenAddresses.forEach(cTokenAddress => {
      promises.push(cTokenContracts[cTokenAddress].methods.balanceOfUnderlying(address).call().then(collateral => {
        return [collateral, cTokenAddress]
      }))
    })

    Promise.all(promises).then(collateralAssets => {
      var largestEthVal = new bigNumber(0)
      var largestTokenBalance
      var assetCTokenAddress
      collateralAssets.forEach(asset => {
        //each asset is an array: [collateralTokens, cTokenAddress]
        //logger.debug(asset[0], tokenData[asset[1]].underlyingPriceInEth.toString(), asset[1])
        var bigNumAsset = new bigNumber(asset[0])
        var underlying = new bigNumber(tokenData[asset[1]].underlyingPriceInEth)
        var ethVal = bigNumAsset.times(underlying)
        //console.log(ethVal.toString(), asset[1])
        if(ethVal.isGreaterThan(largestEthVal)){
          largestEthVal = ethVal
          largestTokenBalance = bigNumAsset
          assetCTokenAddress = asset[1]
        }
      })
      //logger.debug(largestTokenBalance, assetCTokenAddress, largestEthVal.toString())
      resolve([largestTokenBalance, assetCTokenAddress, largestEthVal])
    })
    .catch(reject)
  })
}

calculateProfit = async address => {
  var [largestBorrowBalance, largestBorrowCTokenAddress, largestBorrowInEth] = await getLargestBorrow(address)
  var [largestCollateralBalance, largestCollateralCTokenAddress, largestCollateralInEth] = await getLargestCollateral(address)
  var flashLoanLiquidity = tokenData[largestBorrowCTokenAddress].flashLoanLiquidity


  //calculate how many tokens to repay
  var params = {
    largestBorrowBalance,
    borrowPriceInEth: tokenData[largestBorrowCTokenAddress].underlyingPriceInEth,
    closeFactor,
    collateralPriceInEth: tokenData[largestCollateralCTokenAddress].underlyingPriceInEth,
    largestCollateralBalance,
    flashLoanLiquidity
  }
  var tokensRepaid = amountOfUnderlyingToRepayCompoundLoan(params)

  //calculate how many tokens we will seize
  params.amountRepaid = tokensRepaid
  params.liquidationIncentive = liquidationIncentive
  params.repayPriceInEth = tokenData[largestBorrowCTokenAddress].underlyingPriceInEth
  params.seizePriceInEth = tokenData[largestCollateralCTokenAddress].underlyingPriceInEth
  var tokensSeized = underlyingTokensSeized(params)

  //calculate how much it will cost to repay the flash loan
  var flashLoanRatePercent = new bigNumber(flashLoanRate)
  flashLoanRatePercent = flashLoanRatePercent.shiftedBy(-4).plus(1)
  var flashLoanRepay = tokensRepaid.times(flashLoanRatePercent)

  params.flashLoanRepay = flashLoanRepay
  params.buyToken = tokenData[largestBorrowCTokenAddress].underlyingAddress
  params.sellTokenExchange = tokenData[largestCollateralCTokenAddress].uniswapAddress
  uniswapCost(params)

}

/*
  Calculate the cost (in the seized token) to get enough of the borrowed token to repay our flash loan
  params: {
    bigNumber: flashLoanRepay //the amount of the borrowed token to repay our flash loan (denominated by quantum)
    string: buyToken //the address of the token we are buying (the token we took out our flash loan in and repaid the compound loan in)
    string: sellToken //the address of the token we are selling (the token we seized from repaying the compound loan)
  }
*/
const MAX_VAL = web3.utils.toBN(new bigNumber("99999999999999999116006660312803031653508"))
uniswapCost = async params => {
  const marketDetails
}
/*
  Calculate how much of the underlying currency we will seize
  params: {
    bigNumber: amountRepaid //The amount of the collateral token we will repay
    bigNumber: liquidationIncentive //The multiple of bonus collateral you get for liquidating 1.01 < x < 1.2
    bigNumber: repayPriceInEth //The price in eth of the token we will repay
    bigNumber: seizePriceInEth //The price in eth of the token we will seize
  }
*/

underlyingTokensSeized = params => {
  var ratio = params.repayPriceInEth.div(params.seizePriceInEth)
  var rate = ratio.times(params.liquidationIncentive)
  return rate.times(params.amountRepaid)
}

/*
  Compute the maximum amount that we can liquidate
  params: {
    bigNumber: largestBorrowBalance //The most valuable (in ETH) outStanding borrow on the account denominated in the quantum of each token
    bigNumber: borrowPriceInEth // the amount of ether you get for 1 quantum of the borrowed token
    bigNumber: largestCollateralBalance //the most valuable (in ETH) collateral on the account denominated in the quantum of the underlying asset
    bigNumber: collateralPriceInEth //The amount of ether you get for 1 quantum of the collateral token
    bigNumber: closeFactor //The max amount of the largest Borrow Balance that can be repaid in liquidation 0.1 < x < 0.9
    bigNumber: liquidationIncentive //The multiple of bonus collateral you get for liquidating 1.01 < x < 1.2
    bigNumber: flashLoanLiquidity //the amount of liquidity available for a flash loan in the borrowed currency
  }
*/

amountOfUnderlyingToRepayCompoundLoan = (params) => {
  console.log(` largestBorrowBalance: ${params.largestBorrowBalance}
  closeFactor: ${params.closeFactor}
  borrowPriceInEth: ${params.borrowPriceInEth}`)
  var repayAmount = params.largestBorrowBalance.times(params.closeFactor)//assume we can liquidate the max amount
  var repayAmountInEth = repayAmount.times(params.borrowPriceInEth)
  var collateralTotalInEth = params.largestCollateralBalance.times(params.collateralPriceInEth)
  console.log(repayAmountInEth.toString(), collateralTotalInEth.toString())


  //if the eth value of the amount that can be seized by repaying the largest borrow is more than the ETH value of the largest collateral asset
  //(i.e. we would be overpaying if we paid the default: largest borrow * close factor) calculate the maximum we can liquidate without overpaying
  if(repayAmountInEth.gt(collateralTotalInEth)){
    var ratio = borrowPriceInEth.div(collateralPriceInEth)
    var denominator = liquidationIncentive.times(ratio)
    repayAmount = params.largestCollateralBalance.div(denominator)//Underlying seized / (liq incentive * ratio)
    repayAmountInEth = repayAmount.times(params.borrowPriceInEth)
  }
  if(repayAmount > params.flashLoanLiquidity){//check if aave has enough liquidity to repay this
    repayAmount = params.flashLoanLiquidity
    repayAmountInEth = repayAmount.times(params.borrowPriceInEth)
  }
  return repayAmount
}

getUniswapReserves = async () => {
  for(var i = 0; i < cTokenAddresses.length; i++) {
    if(tokenData[cTokenAddresses[i]].underlyingAddress === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE"){//ether has no uniswap address
      tokenData[cTokenAddresses[i]].uniswapAddress = null
      tokenData[cTokenAddresses[i]].uniswapReserves = undefined
      continue
    }
    tokenData[cTokenAddresses[i]].uniswapAddress = await uniswapFactory.methods.getExchange(tokenData[cTokenAddresses[i]].underlyingAddress).call()
    tokenData[cTokenAddresses[i]].uniswapReserves = await uniswap.getTokenReserves(tokenData[cTokenAddresses[i]].underlyingAddress)
  }
  logger.debug('got uniswap contracts')
  return
}

logger.debug('waiting for web3 connections')
web3.currentProvider.on("connect", async () => {
  await syncData()
  await calculateProfit("0x606420fc17e08ce7d85a5068cede5542c0e47128")
})