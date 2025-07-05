
const ethers = require('ethers');

// Pharos Testnet configuration
const RPC_URLS = [
  'https://testnet.dplabs-internal.com',
];
const ACTIVE_RPC_URL = RPC_URLS[0];
const CHAIN_ID = 688688;

// Token and contract addresses
const TOKEN_ADDRESSES = {
  PHRS: '0x76aaada469d23216be5f7c596fa25f282ff9b364', // WPHRS
  USDC: '0xad902cf99c2de2f1ba5ec4d642fd7e49cae9ee37',
  USDT: '0xEd59De2D7ad9C043442e381231eE3646FC3C2939'
};
const CONTRACT_ADDRESSES = {
  swapRouter: '0x1A4DE519154Ae51200b0Ad7c90F7faC75547888a',
  positionManager: '0xF8a1D4FF0f9b9Af7CE58E1fc1833688F3BFd6115',
  factory: '0x7CE5b44F2d05babd29caE68557F52ab051265F01',
  quoter: '0x00f2f47d1ed593Cf0AF0074173E9DF95afb0206C'
};
const FEE_TIERS = { LOW: 500 };

// Logger
const logger = {
  info: (msg) => console.log(`[${new Date().toISOString()}] INFO: ${msg}`),
  warn: (msg) => console.log(`[${new Date().toISOString()}] WARN: ${msg}`),
  error: (msg) => console.error(`[${new Date().toISOString()}] ERROR: ${msg}`)
};

// Global provider and wallets
let currentProvider;
let globalWallets = [];

// Wallet private keys
const PRIVATE_KEYS = [
 
  '<isi pv key disini>'
];

// --- RPC and Transaction Retry Logic ---
function isNonceRelatedError(error) {
    const message = (error.message || '').toLowerCase();
    const errorCode = error.code;
    let nestedErrorMessage = ''; let nestedErrorCode;

    if (error.error && error.error.body) {
        try {
            const parsedBody = JSON.parse(error.error.body);
            if (parsedBody.error) {
                nestedErrorMessage = (parsedBody.error.message || '').toLowerCase();
                nestedErrorCode = parsedBody.error.code;
            }
        } catch(e) {/*ignore*/}
    } else if (error.error && error.error.message) { nestedErrorMessage = (error.error.message || '').toLowerCase(); }
    
    const combinedMessage = message + nestedErrorMessage;
    const finalErrorCode = nestedErrorCode !== undefined ? nestedErrorCode : errorCode;

    if (combinedMessage.includes('nonce too low') || combinedMessage.includes('nonce has already been used') ||
        combinedMessage.includes('invalid transaction nonce') || combinedMessage.includes('tx_replay_attack') ||
        (finalErrorCode === -32000 && combinedMessage.includes('nonce')) ||
        (finalErrorCode === -32600 && (combinedMessage.includes('replay') || combinedMessage.includes('nonce'))) ||
        combinedMessage.includes('known transaction') || combinedMessage.includes('replacement transaction underpriced')) {
        return true;
    }
    return false;
}

function isRpcError(error) {
    const message = (error.message || '').toLowerCase();
    const reason = (error.reason || '').toLowerCase();
    let topLevelErrorCode = error.code; let httpStatus; let jsonRpcErrorCode; let nestedErrorMessage = '';

    if (isNonceRelatedError(error)) return false; 
    if (topLevelErrorCode === 'TIMEOUT' && message.includes('timeout exceeded')) return false; 

    if (error.error) { 
        topLevelErrorCode = error.error.code || topLevelErrorCode; httpStatus = error.error.status; 
        if (typeof error.error.body === 'string') {
            try {
                const parsedBody = JSON.parse(error.error.body);
                if (parsedBody.error) { jsonRpcErrorCode = parsedBody.error.code; nestedErrorMessage = (parsedBody.error.message || '').toLowerCase(); }
            } catch (e) {}
        } else if (error.error.message) { nestedErrorMessage = (error.error.message || '').toLowerCase(); }
    }
    
    const relevantErrorCode = jsonRpcErrorCode !== undefined ? jsonRpcErrorCode : topLevelErrorCode;
    const relevantErrorMessage = nestedErrorMessage || message;

    if (relevantErrorCode === 'NETWORK_ERROR' || relevantErrorCode === 'SERVER_ERROR') return true;
    if (typeof httpStatus === 'number' && (httpStatus === 500 || httpStatus === 502 || httpStatus === 503 || httpStatus === 504)) return true;
    if (typeof relevantErrorCode === 'number' && (relevantErrorCode === -32603 || (relevantErrorCode <= -32000 && relevantErrorCode >= -32099))) return true;
    
    const combinedMessages = [relevantErrorMessage, message, reason];
    for (const msg of combinedMessages) {
        if (msg.includes('failed to fetch') || msg.includes('network error') || msg.includes('econnrefused') || 
            msg.includes('etimedout') || msg.includes('esockettimedout') || msg.includes('socket hang up') ||
            msg.includes('bad gateway') || msg.includes('service unavailable') || msg.includes('gateway timeout')) return true;
        if (msg.includes('cloudflare') && (msg.includes('1020') || msg.includes('access denied') || msg.includes('connection timed out'))) return true;
    }
    return false;
}

async function retryRpcOperation(asyncFn, operationName, initialDelayMs = 3000, maxDelayMs = 30000, maxAttempts = 3) {
    let currentDelayMs = initialDelayMs;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            if (attempt > 1) logger.info(`Attempt ${attempt}/${maxAttempts} for "${operationName}" on RPC ${ACTIVE_RPC_URL}...`);
            return await asyncFn();
        } catch (error) {
            if (isRpcError(error)) {
                logger.warn(`RPC error during "${operationName}" (Attempt ${attempt}/${maxAttempts} on ${ACTIVE_RPC_URL}): ${error.message}.`);
                if (attempt === maxAttempts) {
                    logger.error(`"${operationName}" failed after ${maxAttempts} RPC retries on ${ACTIVE_RPC_URL}.`);
                    throw error; 
                }
                await new Promise(resolve => setTimeout(resolve, currentDelayMs));
                currentDelayMs = Math.min(Math.floor(currentDelayMs * 1.5), maxDelayMs);
            } else {
                logger.error(`Non-RPC error or unrecoverable issue during "${operationName}" (Attempt ${attempt}/${maxAttempts}): ${error.message}`);
                throw error;
            }
        }
    }
}

async function initializeGlobalProviderAndWallets() {
    logger.info(`Initializing provider for single RPC: ${ACTIVE_RPC_URL}`);
    currentProvider = new ethers.providers.JsonRpcProvider(ACTIVE_RPC_URL, CHAIN_ID);
    await retryRpcOperation(
        async () => {
            const blockNumber = await currentProvider.getBlockNumber();
            logger.info(`Successfully connected to ${ACTIVE_RPC_URL}. Current block: ${blockNumber}.`);
        },
        "Initial RPC Connection", 3000, 30000, 5
    );

    globalWallets = PRIVATE_KEYS.map(key => {
        try { return new ethers.Wallet(key, currentProvider); }
        catch (error) { logger.error(`Invalid PK ${key.slice(0,10)}: ${error.message}`); return null; }
    }).filter(w => w);
    logger.info(`Initialized ${globalWallets.length} wallets.`);
}

async function getNonce(wallet) {
    return await retryRpcOperation(
        async () => {
            const connectedWallet = wallet.provider ? wallet : wallet.connect(currentProvider); // Ensure wallet has provider
            const nonce = await connectedWallet.provider.getTransactionCount(connectedWallet.address, 'pending');
            logger.info(`Nonce for ${connectedWallet.address}: ${nonce}`);
            return nonce;
        }, `Get Nonce for ${wallet.address}`
    );
}

async function confirmTransaction(txHash, maxConfirmAttempts = 5, pollDelay = 10000) {
    logger.info(`Confirming transaction ${txHash} (max ${maxConfirmAttempts} attempts, poll delay ${pollDelay/1000}s)...`);
    for (let i = 0; i < maxConfirmAttempts; i++) {
        const receipt = await retryRpcOperation( 
            async () => await currentProvider.getTransactionReceipt(txHash),
            `Get Receipt for ${txHash} (Confirm Attempt ${i + 1})`
        );
        if (receipt && receipt.blockNumber) { 
            logger.info(`Transaction ${txHash} confirmed in block ${receipt.blockNumber} (status: ${receipt.status}).`);
            return receipt; 
        }
        logger.warn(`Tx ${txHash} not yet confirmed (Attempt ${i + 1}/${maxConfirmAttempts}). Retrying in ${pollDelay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, pollDelay));
    }
    logger.error(`Transaction ${txHash} failed to confirm after ${maxConfirmAttempts} attempts.`);
    return null;
}

async function sendTransactionWithNonceHandling(wallet, operationName, txBuilderFn, defaultGasLimit) {
    const MAX_NONCE_ADJUSTMENT_RETRIES = 2; 
    let lastError;
    const connectedWallet = wallet.provider ? wallet : wallet.connect(currentProvider);


    for (let attempt = 0; attempt <= MAX_NONCE_ADJUSTMENT_RETRIES; attempt++) {
        const currentNonce = await getNonce(connectedWallet);
        logger.info(`Attempting "${operationName}" with nonce ${currentNonce} (Nonce Adjust Attempt ${attempt + 1}/${MAX_NONCE_ADJUSTMENT_RETRIES + 1}) on ${ACTIVE_RPC_URL}`);
        
        const feeData = await (new SwapService(connectedWallet, logger)).getFeeData();

        try {
            const txResponse = await retryRpcOperation( 
                async () => await txBuilderFn(currentNonce, feeData, defaultGasLimit),
                `${operationName} (Nonce: ${currentNonce}) - Send Attempt`
            );
            
            logger.info(`Transaction for "${operationName}" (nonce ${currentNonce}) sent: ${txResponse.hash}`);
            const receipt = await confirmTransaction(txResponse.hash, 5, 10000);

            if (!receipt) {
                lastError = new Error(`Transaction ${txResponse.hash} for "${operationName}" did not confirm after 5 attempts.`);
                logger.error(lastError.message);
                throw lastError; 
            }
            if (receipt.status === 0) {
                lastError = new Error(`Transaction ${txResponse.hash} for "${operationName}" confirmed but failed (status 0).`);
                logger.error(lastError.message);
                throw lastError; 
            }
            logger.info(`"${operationName}" successful with tx: ${txResponse.hash}`);
            return txResponse.hash; 
        } catch (error) {
            lastError = error;
            if (isNonceRelatedError(error)) {
                logger.warn(`Nonce issue for "${operationName}" with nonce ${currentNonce} (Attempt ${attempt + 1}): ${error.message}`);
                if (attempt < MAX_NONCE_ADJUSTMENT_RETRIES) {
                    logger.info("Will re-fetch nonce and retry sending...");
                    await new Promise(resolve => setTimeout(resolve, 3000 + attempt * 2000)); 
                } else {
                    logger.error(`"${operationName}" failed due to persistent nonce issues after ${MAX_NONCE_ADJUSTMENT_RETRIES + 1} attempts.`);
                    break; 
                }
            } else {
                logger.error(`Error during "${operationName}" (Nonce: ${currentNonce}, Attempt ${attempt + 1}): ${error.message}`);
                throw error; 
            }
        }
    }
    throw lastError; 
}

// Contract ABIs
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)','function balanceOf(address account) external view returns (uint256)',
  'function allowance(address owner, address spender) external view returns (uint256)','function decimals() external view returns (uint8)',
];
const POSITION_MANAGER_ABI = [
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function increaseLiquidity(tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function balanceOf(address owner) external view returns (uint256)','function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'
];
const FACTORY_ABI = ['function getPair(address tokenA, address tokenB) external view returns (address pair)'];


// Top-level retry for a whole operation
async function retryOperation(fn, operationName, maxAttempts = 5, initialDelayMs = 10000) {
    let currentDelayMs = initialDelayMs;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            logger.info(`Starting operation "${operationName}", Attempt ${attempt}/${maxAttempts}...`);
            return await fn();
        } catch (error) {
            logger.warn(`Operation "${operationName}" failed on attempt ${attempt}/${maxAttempts}: ${error.message}`);
            if (attempt === maxAttempts) {
                logger.error(`Operation "${operationName}" ultimately failed after ${maxAttempts} attempts.`);
                throw error; 
            }
            if (isNonceRelatedError(error)) { logger.warn(`Persistent nonce-related issue for "${operationName}". Retrying entire operation.`); }
            else if (isRpcError(error)) { logger.warn(`Persistent RPC-related issue for "${operationName}". Retrying entire operation.`);}
            logger.info(`Retrying operation "${operationName}" in ${currentDelayMs / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, currentDelayMs));
            currentDelayMs = Math.min(Math.floor(currentDelayMs * 1.5), 120000);
        }
    }
}

// SwapService
class SwapService {
  constructor(wallet, customLogger) {
    this.wallet = wallet.provider ? wallet : wallet.connect(currentProvider); // Ensure wallet has provider
    this.logger = customLogger || logger;
    this.provider = this.wallet.provider;
  }

  async getFeeData() { 
    return await retryRpcOperation(
        async () => {
            const feeData = await this.provider.getFeeData();
            let gasPriceToSend; let maxFeePerGas, maxPriorityFeePerGas;
            if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
                maxFeePerGas = feeData.maxFeePerGas.mul(120).div(100); maxPriorityFeePerGas = feeData.maxPriorityFeePerGas.mul(120).div(100);
                if (maxPriorityFeePerGas.gt(maxFeePerGas)) { this.logger.warn(`maxPriorityFeePerGas was > maxFeePerGas. Adjusting.`); maxPriorityFeePerGas = maxFeePerGas;}
                return { maxFeePerGas, maxPriorityFeePerGas };
            } else if (feeData.gasPrice) { this.logger.warn("RPC returned legacy gasPrice."); gasPriceToSend = feeData.gasPrice.mul(120).div(100); return { gasPrice: gasPriceToSend };}
            else { this.logger.warn("Could not get EIP-1559 or legacy gasPrice. Fetching manually."); gasPriceToSend = await retryRpcOperation(async() => this.provider.getGasPrice(), "Get Gas Price (Fallback in getFeeData)"); return { gasPrice: gasPriceToSend.mul(120).div(100) };}
        }, "Get Fee Data (SwapService)"
    ).catch(error => { this.logger.warn(`Critical error getting fee data: ${error.message}. Defaulting.`); return { gasPrice: ethers.utils.parseUnits('1.5', 'gwei') }; });
  }
  
  async estimateGas(txForEstimate, operationName = "Estimate Gas") {
     return await retryRpcOperation( async () => await this.provider.estimateGas(txForEstimate), operationName, 3000, 30000, 2)
     .then(gasEstimate => gasEstimate.mul(130).div(100))
     .catch(error => {
        this.logger.warn(`Gas estimation for ${operationName} failed: ${error.message}.`);
        if (error.message.includes("gas required exceeds allowance") || error.message.includes("insufficient funds") || error.code === "UNPREDICTABLE_GAS_LIMIT") { this.logger.error(`Unrecoverable gas est error: ${error.message}.`); throw error;}
        const defaultGas = txForEstimate.data && txForEstimate.data !== '0x' ? ethers.BigNumber.from(300000) : ethers.BigNumber.from(50000);
        this.logger.warn(`Using default gas limit for ${operationName}: ${defaultGas.toString()}`); return defaultGas;
     });
  }

  async swap(fromTokenSymbol, toTokenSymbol, amountString) {
    this.logger.info(`Initiating swap: ${amountString} ${fromTokenSymbol} to ${toTokenSymbol} for ${this.wallet.address}...`);
    
    const tokenInAddress = TOKEN_ADDRESSES[fromTokenSymbol];
    const tokenOutAddress = TOKEN_ADDRESSES[toTokenSymbol];
    if (!tokenInAddress || !tokenOutAddress) throw new Error(`Invalid token pair: ${fromTokenSymbol}/${toTokenSymbol}`);
    
    const tokenInContract = new ethers.Contract(tokenInAddress, ERC20_ABI, this.wallet);
    const tokenInDecimals = await retryRpcOperation(async () => tokenInContract.decimals(), `getDecimals ${fromTokenSymbol}`);
    const amountIn = ethers.utils.parseUnits(amountString, tokenInDecimals);

    const currentAllowance = await retryRpcOperation(async () => tokenInContract.allowance(this.wallet.address, CONTRACT_ADDRESSES.swapRouter), `getAllowance ${fromTokenSymbol}`);
    
    if (currentAllowance.lt(amountIn)) {
      this.logger.info(`Approval needed for ${fromTokenSymbol}.`);
      await sendTransactionWithNonceHandling(
          this.wallet, `Approve ${fromTokenSymbol} for SwapRouter`,
          async (nonce, feeData, defaultGasLimit) => {
              let txOverrides = { nonce, ...feeData };
              try {
                  const estGas = await tokenInContract.estimateGas.approve(CONTRACT_ADDRESSES.swapRouter, ethers.constants.MaxUint256, txOverrides);
                  txOverrides.gasLimit = estGas.mul(130).div(100);
              } catch (e) { this.logger.warn(`Gas est for ${fromTokenSymbol} approve failed, using default ${defaultGasLimit}. Err: ${e.message}`); txOverrides.gasLimit = defaultGasLimit;}
              return tokenInContract.approve(CONTRACT_ADDRESSES.swapRouter, ethers.constants.MaxUint256, txOverrides);
          }, ethers.BigNumber.from(120000)
      );
      this.logger.info(`${fromTokenSymbol} approval successful.`);
    } else { this.logger.info(`${fromTokenSymbol} allowance sufficient.`); }

    const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
    const swapRouterContract = new ethers.Contract(CONTRACT_ADDRESSES.swapRouter, [
        'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
        'function multicall(uint256 deadline, bytes[] calldata data) external payable returns (bytes[] memory results)'
    ], this.wallet);

    const paramsStruct = {
      tokenIn: tokenInAddress, tokenOut: tokenOutAddress, fee: FEE_TIERS.LOW,
      recipient: this.wallet.address, amountIn: amountIn, amountOutMinimum: 0, sqrtPriceLimitX96: 0
    };
    const exactInputSingleCalldata = swapRouterContract.interface.encodeFunctionData("exactInputSingle", [paramsStruct]);
    const txData = swapRouterContract.interface.encodeFunctionData("multicall", [deadline, [exactInputSingleCalldata]]);
    
    const txHash = await sendTransactionWithNonceHandling(
        this.wallet, `Swap ${fromTokenSymbol} to ${toTokenSymbol}`,
        async (nonce, feeData, defaultGasLimit) => { 
            const txForGasEst = { to: CONTRACT_ADDRESSES.swapRouter, data: txData, from: this.wallet.address, value: ethers.BigNumber.from(0) };
            let gasLimit = defaultGasLimit;
            try {
                gasLimit = await this.estimateGas(txForGasEst, `Estimate Gas for Swap Tx (Nonce ${nonce})`) || defaultGasLimit;
            } catch (e) { this.logger.warn(`Swap gas est failed, using default ${defaultGasLimit}. Err: ${e.message}`);}
            return this.wallet.sendTransaction({ to: CONTRACT_ADDRESSES.swapRouter, data: txData, value: 0, nonce, ...feeData, gasLimit });
        }, ethers.BigNumber.from(400000) 
    );
    this.logger.info(`Swap transaction confirmed: https://testnet.pharosscan.xyz/tx/${txHash}`);
    return txHash;
  }
}

async function checkBalances(wallet) { 
  const operation = `checkBalances for ${wallet.address}`;
  logger.info(`${operation}...`);
  const connectedWallet = wallet.provider ? wallet : wallet.connect(currentProvider);

  try {
    const phrsTokenContract = new ethers.Contract(TOKEN_ADDRESSES.PHRS, ERC20_ABI, connectedWallet.provider);
    const usdcTokenContract = new ethers.Contract(TOKEN_ADDRESSES.USDC, ERC20_ABI, connectedWallet.provider);

    const nativeBalance = await retryRpcOperation(async () => connectedWallet.getBalance(), `${operation} native`);
    const phrsTokenBalance = await retryRpcOperation(async () => phrsTokenContract.balanceOf(connectedWallet.address), `${operation} WPHRS`);
    const usdcBalance = await retryRpcOperation(async () => usdcTokenContract.balanceOf(connectedWallet.address), `${operation} USDC`);
    const phrsDecimals = await retryRpcOperation(async () => phrsTokenContract.decimals(), `${operation} WPHRS decimals`);
    const usdcDecimals = await retryRpcOperation(async () => usdcTokenContract.decimals(), `${operation} USDC decimals`);

    logger.info(`Native PHRS (gas): ${ethers.utils.formatUnits(nativeBalance, 18)} PHRS`);
    logger.info(`PHRS Token (WPHRS): ${ethers.utils.formatUnits(phrsTokenBalance, phrsDecimals)} WPHRS`);
    logger.info(`USDC: ${ethers.utils.formatUnits(usdcBalance, usdcDecimals)} USDC`);
    return { nativeBalance, phrsTokenBalance, usdcBalance, phrsDecimals, usdcDecimals };
  } catch (error) { 
    logger.error(`Balance check failed for ${wallet.address} after retries: ${error.message}`); 
    return { nativeBalance: ethers.BigNumber.from(0), phrsTokenBalance: ethers.BigNumber.from(0), usdcBalance: ethers.BigNumber.from(0), phrsDecimals: 18, usdcDecimals: 6 };
  }
}
async function getPairAddress(tokenA, tokenB) { 
    const operation = `getPairAddress ${tokenA}-${tokenB}`;
    const factoryContract = new ethers.Contract(CONTRACT_ADDRESSES.factory, FACTORY_ABI, currentProvider);
    try {
        const pair = await retryRpcOperation(async () => factoryContract.getPair(tokenA, tokenB), operation);
        logger.info(`Pair address for V2 Factory ${tokenA}-${tokenB}: ${pair}`);
        return pair === ethers.constants.AddressZero ? null : pair;
    } catch (error) {
        logger.warn(`Failed to fetch V2 pair address for ${tokenA}-${tokenB}: ${error.message}`);
        return null;
    }
}
async function findExistingPosition(wallet, token0Addr, token1Addr, fee) { 
 const operation = `findExistingPosition for ${wallet.address}`;
  logger.info(`${operation}...`);
  const connectedWallet = wallet.provider ? wallet : wallet.connect(currentProvider);
  const positionManager = new ethers.Contract(CONTRACT_ADDRESSES.positionManager, POSITION_MANAGER_ABI, connectedWallet);
  try {
    const balance = await retryRpcOperation(async () => positionManager.balanceOf(connectedWallet.address), `${operation} balance`);
    if (balance.isZero()) { logger.info(`${operation}: No positions found.`); return null; }

    token0Addr = token0Addr.toLowerCase(); token1Addr = token1Addr.toLowerCase();
    logger.info(`Found ${balance.toString()} NFT positions. Checking...`);
    for (let i = 0; i < balance.toNumber(); i++) {
      let tokenId;
      try {
        tokenId = await retryRpcOperation(async () => positionManager.tokenOfOwnerByIndex(connectedWallet.address, i), `${operation} tokenOfOwnerByIndex ${i}`);
        const position = await retryRpcOperation(async () => positionManager.positions(tokenId), `${operation} positions ${tokenId}`);
        const posToken0 = position.token0.toLowerCase(); const posToken1 = position.token1.toLowerCase();
        if ( ((posToken0 === token0Addr && posToken1 === token1Addr) || (posToken0 === token1Addr && posToken1 === token0Addr)) && position.fee === fee ) {
          logger.info(`${operation}: Found existing position #${tokenId}`);
          return { tokenId, token0: position.token0, token1: position.token1, tickLower: position.tickLower, tickUpper: position.tickUpper };
        }
      } catch (err) { logger.warn(`${operation}: Error checking position index ${i} (TokenID: ${tokenId || 'unknown'}): ${err.message}. Skipping.`); continue; }
    }
    logger.info(`${operation}: No matching existing position found.`); return null;
  } catch (error) { logger.error(`${operation} failed: ${error.message}`); return null; }
}

async function executeSwapUsdcToPhrs(wallet, currentBalances, swapService, amountToSwapString) {
  const operation = `Execute Swap USDC to PHRS for ${wallet.address}`;
  logger.info(`${operation} (${amountToSwapString} USDC)...`);

  const amountInParsed = ethers.utils.parseUnits(amountToSwapString, currentBalances.usdcDecimals);
  if (currentBalances.usdcBalance.lt(amountInParsed)) {
    throw new Error(`Insufficient USDC balance: ${ethers.utils.formatUnits(currentBalances.usdcBalance, currentBalances.usdcDecimals)} USDC, need ${amountToSwapString}`);
  }
  const estimatedGasCostForSwap = ethers.utils.parseUnits('0.005', 18);
  if (currentBalances.nativeBalance.lt(estimatedGasCostForSwap)) {
     throw new Error(`Insufficient native PHRS for gas: ${ethers.utils.formatUnits(currentBalances.nativeBalance, 18)} PHRS, estimated need ~${ethers.utils.formatUnits(estimatedGasCostForSwap, 18)}`);
  }

  const txHash = await swapService.swap('USDC', 'PHRS', amountToSwapString); // swapService.swap now uses sendTransactionWithNonceHandling
  if (!txHash) throw new Error('Swap USDC to PHRS failed to return transaction hash.');
  logger.info(`USDC to PHRS swap completed: https://testnet.pharosscan.xyz/tx/${txHash}`);
}

async function autoAddLiquidity(wallet, currentBalances) {
  const operation = `Auto Add Liquidity for ${wallet.address}`;
  logger.info(`${operation}...`);

  const connectedWallet = wallet.provider ? wallet : wallet.connect(currentProvider);
  const phrsContract = new ethers.Contract(TOKEN_ADDRESSES.PHRS,ERC20_ABI,connectedWallet);
  const usdcContract = new ethers.Contract(TOKEN_ADDRESSES.USDC,ERC20_ABI,connectedWallet);
  const positionManager=new ethers.Contract(CONTRACT_ADDRESSES.positionManager,POSITION_MANAGER_ABI,connectedWallet);
  const swapServiceForGasEst = new SwapService(connectedWallet, logger); // For estimateGas

  const targetPhrsToAdd = 0.001; const feeTier = FEE_TIERS.LOW;
  const tickLower = Math.ceil(-887272/10)*10; const tickUpper = Math.floor(887272/10)*10;
  logger.info(`Using tick range: [${tickLower}, ${tickUpper}]`);

  const {phrsTokenBalance,usdcBalance,phrsDecimals,usdcDecimals, nativeBalance} = currentBalances;
  let amountPhrsDesired = ethers.utils.parseUnits(targetPhrsToAdd.toString(),phrsDecimals);
  let amountUsdcDesired;

  if(phrsTokenBalance.lt(amountPhrsDesired)){throw new Error(`Insuff WPHRS. Need ${targetPhrsToAdd}.`);}
  const estimatedGasForLiquidity = ethers.utils.parseUnits('0.01', 18); 
  if (nativeBalance.lt(estimatedGasForLiquidity)) {
    throw new Error(`Insufficient native PHRS for gas: have ${ethers.utils.formatUnits(nativeBalance, 18)}, need ~${ethers.utils.formatUnits(estimatedGasForLiquidity, 18)}`);
  }


  let token0Addr=TOKEN_ADDRESSES.PHRS; let token1Addr=TOKEN_ADDRESSES.USDC; 
  let isPhrsT0=true;
  if(ethers.BigNumber.from(token0Addr).gt(ethers.BigNumber.from(token1Addr))){
    [token0Addr,token1Addr]=[token1Addr,token0Addr]; isPhrsT0=false;
    logger.info(`Pool order: token0=USDC, token1=WPHRS`);
  } else { logger.info(`Pool order: token0=WPHRS, token1=USDC`);}

  const poolAddrV2 = await getPairAddress(TOKEN_ADDRESSES.PHRS,TOKEN_ADDRESSES.USDC); // V2 pair for ratio
  let smallDefUsdc = 0.001;

  if(poolAddrV2){ // Using V2 pair for reserves to calculate ratio
    const pairContract = new ethers.Contract(poolAddrV2, ['function getReserves() external view returns (uint112 r0, uint112 r1, uint32 ts)', 'function token0() external view returns (address)'], currentProvider);
    try {
      const { r0, r1 } = await retryRpcOperation(async()=>pairContract.getReserves(),`${operation} getReserves`);
      const pairT0 = await retryRpcOperation(async()=>pairContract.token0(), `${operation} pairToken0`);
      let reservePhrs, reserveUsdc;
      if (pairT0.toLowerCase() === TOKEN_ADDRESSES.PHRS.toLowerCase()) { reservePhrs=r0; reserveUsdc=r1; } else { reservePhrs=r1; reserveUsdc=r0; }
      if (!reservePhrs.isZero() && !reserveUsdc.isZero()) {
        amountUsdcDesired = amountPhrsDesired.mul(reserveUsdc).div(reservePhrs);
        logger.info(`Adjusted USDC based on V2 reserves: ${ethers.utils.formatUnits(amountUsdcDesired, usdcDecimals)} for ${targetPhrsToAdd} WPHRS`);
      } else { amountUsdcDesired = ethers.utils.parseUnits(smallDefUsdc.toString(),usdcDecimals); logger.warn(`${operation}: V2 Reserves zero, using default USDC.`);}
    } catch(e){logger.warn(`Could not read V2 reserves: ${e.message}. Default USDC.`); amountUsdcDesired = ethers.utils.parseUnits(smallDefUsdc.toString(),usdcDecimals);}
  } else {logger.info('No V2 pair for ratio calc. Using default USDC for V3 pool.'); amountUsdcDesired = ethers.utils.parseUnits(smallDefUsdc.toString(),usdcDecimals);}

  if(usdcBalance.lt(amountUsdcDesired)){throw new Error(`Insuff USDC. Need ${ethers.utils.formatUnits(amountUsdcDesired,usdcDecimals)}.`);}
  
  const phrsAllowance = await retryRpcOperation(async()=>phrsContract.allowance(connectedWallet.address,CONTRACT_ADDRESSES.positionManager),`${operation} Get PHRS Allow`);
  if(phrsAllowance.lt(amountPhrsDesired)){
    await sendTransactionWithNonceHandling( connectedWallet, `${operation} Approve PHRS`,
        async (nonce, feeData, defaultGasLimit) => {
            let txOverrides = { nonce, ...feeData };
            try {
                const estGas = await phrsContract.estimateGas.approve(CONTRACT_ADDRESSES.positionManager, ethers.constants.MaxUint256, txOverrides);
                txOverrides.gasLimit = estGas.mul(130).div(100);
            } catch (e) { logger.warn(`Gas est for PHRS approve failed. Default: ${defaultGasLimit}. Err: ${e.message}`); txOverrides.gasLimit = defaultGasLimit;}
            return phrsContract.approve(CONTRACT_ADDRESSES.positionManager,ethers.constants.MaxUint256,txOverrides);
        }, ethers.BigNumber.from(120000)
    );
    logger.info('PHRS approval successful.');
  } else {logger.info('PHRS approval sufficient.');}

  const usdcAllowance = await retryRpcOperation(async()=>usdcContract.allowance(connectedWallet.address,CONTRACT_ADDRESSES.positionManager),`${operation} Get USDC Allow`);
  if(usdcAllowance.lt(amountUsdcDesired)){
    await sendTransactionWithNonceHandling( connectedWallet, `${operation} Approve USDC`,
        async (nonce, feeData, defaultGasLimit) => {
            let txOverrides = { nonce, ...feeData };
            try {
                const estGas = await usdcContract.estimateGas.approve(CONTRACT_ADDRESSES.positionManager, ethers.constants.MaxUint256, txOverrides);
                txOverrides.gasLimit = estGas.mul(130).div(100);
            } catch (e) { logger.warn(`Gas est for USDC approve failed. Default: ${defaultGasLimit}. Err: ${e.message}`); txOverrides.gasLimit = defaultGasLimit;}
            return usdcContract.approve(CONTRACT_ADDRESSES.positionManager,ethers.constants.MaxUint256,txOverrides);
        }, ethers.BigNumber.from(120000)
    );
    logger.info('USDC approval successful.');
  } else {logger.info('USDC approval sufficient.');}

  const finalAmount0Desired = isPhrsT0?amountPhrsDesired:amountUsdcDesired;
  const finalAmount1Desired = isPhrsT0?amountUsdcDesired:amountPhrsDesired;
  const finalToken0Decimals = isPhrsT0?phrsDecimals:usdcDecimals;
  const finalToken1Decimals = isPhrsT0?usdcDecimals:phrsDecimals;

  const descAmt0 = ethers.utils.formatUnits(finalAmount0Desired, finalToken0Decimals);
  const descAmt1 = ethers.utils.formatUnits(finalAmount1Desired, finalToken1Decimals);
  const sym0 = isPhrsT0?"WPHRS":"USDC"; const sym1 = isPhrsT0?"USDC":"WPHRS";

  const existPos = await findExistingPosition(connectedWallet,TOKEN_ADDRESSES.PHRS,TOKEN_ADDRESSES.USDC,feeTier);
  let txHash;

  if(existPos && existPos.tickLower===tickLower && existPos.tickUpper===tickUpper){
    logger.info(`${operation}: Increasing liq for pos #${existPos.tokenId}.`);
    const params = {tokenId:existPos.tokenId,amount0Desired:finalAmount0Desired,amount1Desired:finalAmount1Desired,amount0Min:0,amount1Min:0,deadline:Math.floor(Date.now()/1000)+1200};
    logger.info(`Increasing with: ${descAmt0} ${sym0}, ${descAmt1} ${sym1}`);
    txHash = await sendTransactionWithNonceHandling( connectedWallet, `${operation} Increase Liquidity`,
        async (nonce, feeData, defaultGasLimit) => {
            let txOverrides = { nonce, ...feeData };
            try {
                 const estGas = await positionManager.estimateGas.increaseLiquidity(params, txOverrides);
                 txOverrides.gasLimit = estGas.mul(130).div(100);
            } catch(e) {logger.warn(`Gas est for Increase Liq failed. Default: ${defaultGasLimit}. Err: ${e.message}`); txOverrides.gasLimit = defaultGasLimit;}
            return positionManager.increaseLiquidity(params,txOverrides);
        }, ethers.BigNumber.from(700000)
    );
  } else {
    if(existPos) logger.info(`Existing pos #${existPos.tokenId} has diff ticks. Minting new.`);
    else logger.info('Minting new liq pos...');
    const mintParams = {token0:token0Addr,token1:token1Addr,fee:feeTier,tickLower,tickUpper,amount0Desired:finalAmount0Desired,amount1Desired:finalAmount1Desired,amount0Min:0,amount1Min:0,recipient:connectedWallet.address,deadline:Math.floor(Date.now()/1000)+1200};
    logger.info(`Minting with: ${descAmt0} ${sym0}, ${descAmt1} ${sym1}`);
    txHash = await sendTransactionWithNonceHandling( connectedWallet, `${operation} Mint Liquidity`,
        async (nonce, feeData, defaultGasLimit) => {
            let txOverrides = { nonce, ...feeData };
             try {
                 const estGas = await positionManager.estimateGas.mint(mintParams, txOverrides);
                 txOverrides.gasLimit = estGas.mul(130).div(100);
            } catch(e) {logger.warn(`Gas est for Mint Liq failed. Default: ${defaultGasLimit}. Err: ${e.message}`); txOverrides.gasLimit = defaultGasLimit;}
            return positionManager.mint(mintParams,txOverrides);
        }, ethers.BigNumber.from(1000000)
    );
  }
  logger.info(`${operation}: Liquidity op successful: https://testnet.pharosscan.xyz/tx/${txHash}`);
}

// Main execution
async function main() {
  // CSSURABAYA_ASCII removed as per request
  logger.info('Starting Pharos Testnet Bot - Hardcoded Keys, Single RPC, Enhanced Retries');
  
  try {
    await initializeGlobalProviderAndWallets();
  } catch (error) {
    logger.error(`Failed to initialize provider or wallets. Exiting. Error: ${error.message}`);
    process.exit(1);
  }

  if (globalWallets.length === 0) {
    logger.error('No valid wallets initialized from PRIVATE_KEYS. Exiting.');
    return;
  }

  const LOOP_COUNT = 100; 
  const SWAP_USDC_AMOUNT_STRING = "0.001"; 
  const DELAY_BETWEEN_WALLET_ACTIONS_MS = 10000; 
  const DELAY_BETWEEN_LOOPS_MS = 5000; 

  for (const wallet of globalWallets) {
    logger.info(`\n--- Processing wallet: ${wallet.address} ---`);
    const swapService = new SwapService(wallet, logger);
    let currentBalances;
    try {
        currentBalances = await checkBalances(wallet);
    } catch (balanceError) {
        logger.error(`Could not fetch initial balances for ${wallet.address}: ${balanceError.message}. Skipping wallet.`);
        continue;
    }

    logger.info(`Starting USDC to WPHRS swaps for ${wallet.address} (${LOOP_COUNT} loops)`);
    for (let i = 0; i < LOOP_COUNT; i++) {
      logger.info(`Swap USDC to WPHRS - Loop ${i + 1}/${LOOP_COUNT} for ${wallet.address}`);
      try {
        currentBalances = await checkBalances(wallet); 
        await retryOperation( 
            () => executeSwapUsdcToPhrs(wallet, currentBalances, swapService, SWAP_USDC_AMOUNT_STRING),
            `Swap USDC to PHRS Loop ${i+1}`,
            5 // 5 attempts for the entire swap operation
        );
      } catch (error) {
        logger.error(`Swap Loop ${i + 1} for ${wallet.address} ultimately failed: ${error.message}`);
        if (error.message.toLowerCase().includes("insufficient")) {
            logger.warn(`Stopping swaps for wallet ${wallet.address} due to insufficient funds.`);
            break; 
        }
      }
      if (i < LOOP_COUNT - 1) {
          logger.info(`Waiting ${DELAY_BETWEEN_LOOPS_MS / 1000}s before next swap loop...`);
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_LOOPS_MS));
      }
    }

    logger.info(`Starting Add Liquidity for ${wallet.address} (${LOOP_COUNT} loops)`);
    for (let i = 0; i < LOOP_COUNT; i++) {
      logger.info(`Add Liquidity - Loop ${i + 1}/${LOOP_COUNT} for ${wallet.address}`);
      try {
        currentBalances = await checkBalances(wallet); 
        await retryOperation( 
            () => autoAddLiquidity(wallet, currentBalances),
            `Add Liquidity Loop ${i+1}`,
            5 // 5 attempts for the entire liquidity operation
        );
      } catch (error) {
        logger.error(`Add Liquidity Loop ${i + 1} for ${wallet.address} ultimately failed: ${error.message}`);
         if (error.message.toLowerCase().includes("insufficient")){
            logger.warn(`Stopping liquidity ops for wallet ${wallet.address} due to insufficient funds.`);
            break; 
        }
      }
       if (i < LOOP_COUNT - 1) {
          logger.info(`Waiting ${DELAY_BETWEEN_LOOPS_MS / 1000}s before next liquidity loop...`);
          await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_LOOPS_MS));
      }
    }
    logger.info(`--- Finished processing wallet: ${wallet.address} ---`);
    if (globalWallets.indexOf(wallet) < globalWallets.length - 1) {
        logger.info(`Waiting ${DELAY_BETWEEN_WALLET_ACTIONS_MS / 1000}s before processing next wallet...`);
        await new Promise(resolve => setTimeout(resolve, DELAY_BETWEEN_WALLET_ACTIONS_MS));
    }
  }
  logger.info('All wallet processing completed.');
}

main()
  .then(() => { logger.info('Script execution finished.'); process.exit(0); })
  .catch(error => { logger.error(`Unhandled fatal error: ${error.message} ${error.stack}`); process.exit(1); });
