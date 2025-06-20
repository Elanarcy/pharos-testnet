const ethers = require('ethers');
const axios = require('axios');
const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });
const fs =require('fs').promises;
const path = require('path');

// --- Script Introduction ---
const CSSURABAYA_ASCII = `
███████╗██╗░░░░░░█████╗░███╗░░██╗░█████╗░██████╗░░█████╗░██╗░░░██╗
██╔════╝██║░░░░░██╔══██╗████╗░██║██╔══██╗██╔══██╗██╔══██╗╚██╗░██╔╝
█████╗░░██║░░░░░███████║██╔██╗██║███████║██████╔╝██║░░╚═╝░╚████╔╝░
██╔══╝░░██║░░░░░██╔══██║██║╚████║██╔══██║██╔══██╗██║░░██╗░░╚██╔╝░░
███████╗███████╗██║░░██║██║░╚███║██║░░██║██║░░██║╚█████╔╝░░░██║░░░
╚══════╝╚══════╝╚═╝░░╚═╝╚═╝░░╚══╝╚═╝░░╚═╝╚═╝░░╚═╝░╚════╝░░░░╚═╝░░░
`;
const TELEGRAM_CHANNEL = "t.me/cssurabaya";

// Pharos Testnet configuration
const RPC_URLS = [
    'https://testnet.dplabs-internal.com' // Zan RPC
];
const ACTIVE_RPC_URL = RPC_URLS[0];

const CHAIN_ID = 688688;
const PHAROS_API_URL = 'https://api.pharosnetwork.xyz/task/verify';

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

let provider;

const logger = {
  info: (msg) => console.log(`INFO: ${msg}`),
  warn: (msg) => console.log(`WARN: ${msg}`),
  error: (msg) => console.error(`ERROR: ${msg}`)
};

// --- RPC and Transaction Retry Logic ---
function isNonceRelatedError(error) {
    const message = (error.message || '').toLowerCase();
    const errorCode = error.code;
    let nestedErrorMessage = '';
    let nestedErrorCode;

    if (error.error && error.error.body) {
        try {
            const parsedBody = JSON.parse(error.error.body);
            if (parsedBody.error) {
                nestedErrorMessage = (parsedBody.error.message || '').toLowerCase();
                nestedErrorCode = parsedBody.error.code;
            }
        } catch(e) {/*ignore*/}
    } else if (error.error && error.error.message) {
        nestedErrorMessage = (error.error.message || '').toLowerCase();
    }
    
    const combinedMessage = message + nestedErrorMessage;
    const finalErrorCode = nestedErrorCode !== undefined ? nestedErrorCode : errorCode;

    if (combinedMessage.includes('nonce too low') ||
        combinedMessage.includes('nonce has already been used') ||
        combinedMessage.includes('invalid transaction nonce') ||
        combinedMessage.includes('tx_replay_attack') ||
        (finalErrorCode === -32000 && combinedMessage.includes('nonce')) ||
        (finalErrorCode === -32600 && (combinedMessage.includes('replay') || combinedMessage.includes('nonce'))) ||
        combinedMessage.includes('known transaction') ||
        combinedMessage.includes('replacement transaction underpriced')
    ) {
        return true;
    }
    return false;
}

function isRpcError(error) {
    const message = (error.message || '').toLowerCase();
    const reason = (error.reason || '').toLowerCase();
    let topLevelErrorCode = error.code;
    let httpStatus;
    let jsonRpcErrorCode;
    let nestedErrorMessage = '';

    if (isNonceRelatedError(error)) {
        return false;
    }
    
    if (topLevelErrorCode === 'TIMEOUT' && message.includes('timeout exceeded')) {
        logger.warn(`Operation timeout (e.g., waiting for transaction): ${error.message}. Not treating as a generic RPC retry case here.`);
        return false; 
    }

    if (error.error) { 
        topLevelErrorCode = error.error.code || topLevelErrorCode; 
        httpStatus = error.error.status; 
        if (typeof error.error.body === 'string') {
            try {
                const parsedBody = JSON.parse(error.error.body);
                if (parsedBody.error) {
                    jsonRpcErrorCode = parsedBody.error.code; 
                    nestedErrorMessage = (parsedBody.error.message || '').toLowerCase();
                }
            } catch (e) { /* ignore parsing error */ }
        } else if (error.error.message) {
            nestedErrorMessage = (error.error.message || '').toLowerCase();
        }
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
            msg.includes('bad gateway') || msg.includes('service unavailable') || msg.includes('gateway timeout')) {
            return true;
        }
        if (msg.includes('cloudflare') && (msg.includes('1020') || msg.includes('access denied') || msg.includes('connection timed out'))) return true;
    }
    
    return false;
}

async function retryRpcOperation(asyncFn, operationName, initialDelayMs = 5000, maxDelayMs = 120000) {
    let currentDelayMs = initialDelayMs;
    let attempt = 0;
    while (true) {
        try {
            attempt++;
            if (attempt > 1) logger.info(`Attempt ${attempt} for "${operationName}"...`);
            return await asyncFn();
        } catch (error) {
            if (isRpcError(error)) {
                logger.warn(`RPC error during "${operationName}" (Attempt ${attempt}): ${error.message}. Retrying in ${currentDelayMs / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, currentDelayMs));
                currentDelayMs = Math.min(Math.floor(currentDelayMs * 1.5), maxDelayMs);
            } else {
                logger.error(`Non-RPC error or unrecoverable RPC error during "${operationName}" (Attempt ${attempt}): ${error.message}`);
                throw error; 
            }
        }
    }
}

async function initializeGlobalProvider() {
    logger.info(`Initializing provider for RPC: ${ACTIVE_RPC_URL}`);
    const providerInstance = new ethers.providers.JsonRpcProvider(ACTIVE_RPC_URL, CHAIN_ID);
    await retryRpcOperation(
        async () => {
            const blockNumber = await providerInstance.getBlockNumber();
            logger.info(`Successfully connected to ${ACTIVE_RPC_URL}. Current block: ${blockNumber}.`);
        },
        "Initial RPC Connection", 3000, 30000
    );
    return providerInstance;
}

async function sendTransactionWithNonceHandling(wallet, operationName, txBuilderFn, defaultGasLimit) {
    const MAX_NONCE_ADJUSTMENT_RETRIES = 2; 
    let lastError;

    for (let attempt = 0; attempt <= MAX_NONCE_ADJUSTMENT_RETRIES; attempt++) {
        const currentNonce = await getNonce(wallet); 
        logger.info(`Attempting "${operationName}" with nonce ${currentNonce} (Nonce Adjust Attempt ${attempt + 1}/${MAX_NONCE_ADJUSTMENT_RETRIES + 1})`);
        
        const feeData = await (new SwapService(wallet, logger)).getFeeData(); 

        try {
            const txResponse = await retryRpcOperation( 
                async () => await txBuilderFn(currentNonce, feeData, defaultGasLimit),
                `${operationName} (Nonce: ${currentNonce}) - Send Attempt`
            );
            
            logger.info(`Transaction for "${operationName}" (nonce ${currentNonce}) sent: ${txResponse.hash}`);
            
            const confirmed = await confirmTransaction(txResponse.hash, 5, 10000); // CHANGED: maxRetries from 15 to 5
            if (!confirmed) {
                lastError = new Error(`Transaction ${txResponse.hash} for "${operationName}" did not confirm after 5 attempts.`); // CHANGED: Updated error message
                logger.error(lastError.message);
                throw lastError; 
            }
            
            const receipt = await retryRpcOperation(
                async () => provider.getTransactionReceipt(txResponse.hash),
                `Get Final Receipt for ${txResponse.hash} (${operationName})`
            );

            if (!receipt) {
                 lastError = new Error(`No receipt found for confirmed TX ${txResponse.hash} for "${operationName}".`);
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
const FACTORY_ABI = ['function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)'];

async function getNonce(wallet) {
    return await retryRpcOperation(
        async () => {
            const nonce = await wallet.provider.getTransactionCount(wallet.address, 'pending');
            logger.info(`Nonce for ${wallet.address}: ${nonce}`);
            return nonce;
        }, `Get Nonce for ${wallet.address}`
    );
}

async function verifyTask(walletAddress, taskId, txHash) { 
  try {
    if (!ethers.utils.isHexString(txHash, 32)) { throw new Error(`Invalid transaction hash: ${txHash}`); }
    const url = `${PHAROS_API_URL}?address=${walletAddress}&task_id=${taskId}&tx_hash=${txHash}`;
    logger.info(`Sending verification request (no JWT): ${url}`);
    let response = await axios.post( url, {}, {
        headers: {
          'Content-Type': 'application/json', 'Referer': 'https://testnet.pharosnetwork.xyz/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*', 'Origin': 'https://testnet.pharosnetwork.xyz'
        }
      });
    logger.info(`API response: ${JSON.stringify(response.data)}`);
    const { code, data, msg } = response.data;
    if (code === 0 && data.verified) { logger.info(`Task ${taskId} verified: ${msg}`); return true; }
    else {
      logger.warn(`Task ${taskId} verification (query params) failed: ${msg}. Code: ${code}`);
      if (msg && (msg.includes('VerifyRequest.Address') || msg.includes('VerifyRequest.TaskID') || msg.includes('tx hash invalid'))) {} 
      else if (code !==0) { throw new Error(`Verification failed with query params: ${msg}`); }
    }
  } catch (error) { logger.warn(`Initial verification with query params failed: ${error.response?.data?.msg || error.message}. Attempting JSON payload...`); }
  try {
    const payload = { Address: walletAddress, TaskID: taskId, TxHash: txHash };
    logger.info(`Sending verification request with JSON payload (no JWT): ${JSON.stringify(payload)}`);
    const response = await axios.post( PHAROS_API_URL, payload, {
        headers: {
          'Content-Type': 'application/json', 'Referer': 'https://testnet.pharosnetwork.xyz/',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*', 'Origin': 'https://testnet.pharosnetwork.xyz'
        }
      });
    logger.info(`API response (JSON payload): ${JSON.stringify(response.data)}`);
    const { code, data, msg } = response.data;
    if (code === 0 && data.verified) { logger.info(`Task ${taskId} verified via JSON payload: ${msg}`); return true; }
    else { logger.warn(`Task ${taskId} verification failed via JSON payload: ${msg}. Code: ${code}`); throw new Error(`Verification failed via JSON payload: ${msg}`);}
  } catch (finalError) {
    logger.error(`All verification attempts for task ${taskId} failed: ${finalError.response?.data?.msg || finalError.message}`);
    if (finalError.response?.status === 429) { logger.warn(`Rate limit exceeded during verification. Retrying after 10 seconds...`); await new Promise(resolve => setTimeout(resolve, 10000)); throw finalError; }
    else if (finalError.response?.status === 401) { logger.error(`Unauthorized (401): API might require authentication.`); throw new Error(`Unauthorized: API might require authentication.`);}
    throw finalError;
  }
}
async function logFailedVerification(walletAddress, taskId, txHash, operationDescription = "Unknown Operation") { 
  const logEntry = `Wallet: ${walletAddress}, TaskID: ${taskId}, Operation: ${operationDescription}, TxHash: ${txHash}, Explorer: https://testnet.pharosscan.xyz/tx/${txHash}, Timestamp: ${new Date().toISOString()}\nManual verification steps:\n1. Visit https://testnet.pharosnetwork.xyz\n2. Log in with wallet ${walletAddress}\n3. Go to Experience > Tasks > Verify\n4. Enter Task ID ${taskId}, Wallet Address ${walletAddress}, and TxHash ${txHash}\n5. Submit and confirm\n\n`;
  try { await fs.appendFile('failed_verifications.txt', logEntry); logger.info(`Logged failed verification to failed_verifications.txt for ${operationDescription}.`); }
  catch (e) { logger.error(`Failed to write to failed_verifications.txt: ${e.message}`);}
}

async function confirmTransaction(txHash, maxRetries = 5, initialDelay = 10000) { // CHANGED: Default maxRetries to 5
    let currentDelay = initialDelay;
    logger.info(`Confirming transaction ${txHash} (max ${maxRetries} attempts, initial delay ${initialDelay/1000}s)...`);
    for (let i = 0; i < maxRetries; i++) {
        const receipt = await retryRpcOperation( 
            async () => await provider.getTransactionReceipt(txHash),
            `Get Receipt for ${txHash} (Confirm Attempt ${i + 1})`
        );
        if (receipt && receipt.blockNumber) { 
            logger.info(`Transaction ${txHash} confirmed in block ${receipt.blockNumber} (status: ${receipt.status}).`);
            return true; 
        }
        logger.warn(`Tx ${txHash} not yet confirmed (Attempt ${i + 1}/${maxRetries}). Retrying in ${currentDelay / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, currentDelay));
        currentDelay = Math.min(currentDelay + 5000, 60000); 
    }
    logger.error(`Transaction ${txHash} failed to confirm after ${maxRetries} attempts.`);
    return false;
}

class SwapService {
  constructor(wallet, logger) {
    this.wallet = wallet;
    this.logger = logger;
    this.provider = wallet.provider;
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
        }, "Get Fee Data"
    ).catch(error => { this.logger.warn(`Critical error getting fee data: ${error.message}. Defaulting.`); return { gasPrice: ethers.utils.parseUnits('1.5', 'gwei') }; });
  }
  async estimateGas(txForEstimate, operationName = "Estimate Gas") {
     return await retryRpcOperation( async () => await this.provider.estimateGas(txForEstimate), operationName, 3000, 30000)
     .then(gasEstimate => gasEstimate.mul(130).div(100))
     .catch(error => {
        this.logger.warn(`Gas estimation for ${operationName} failed: ${error.message}.`);
        if (error.message.includes("gas required exceeds allowance") || error.message.includes("insufficient funds") || error.code === "UNPREDICTABLE_GAS_LIMIT") { this.logger.error(`Unrecoverable gas est error: ${error.message}.`); throw error;}
        const defaultGas = txForEstimate.value && !ethers.BigNumber.from(txForEstimate.value).isZero() ? ethers.BigNumber.from(50000) : ethers.BigNumber.from(200000);
        this.logger.warn(`Using default gas limit for ${operationName}: ${defaultGas.toString()}`); return defaultGas;
     });
  }

  async swap(fromToken, toToken, amount) {
    this.logger.info(`Initiating swap: ${amount} ${fromToken} to ${toToken} for ${this.wallet.address}...`);
    try {
      const tokenInAddress = TOKEN_ADDRESSES[fromToken];
      const tokenOutAddress = TOKEN_ADDRESSES[toToken];
      if (!tokenInAddress || !tokenOutAddress) throw new Error(`Invalid token pair`);
      
      const tokenInContract = new ethers.Contract(tokenInAddress, ERC20_ABI, this.wallet);
      const decimalsIn = await retryRpcOperation(async () => tokenInContract.decimals(), `Get Decimals for ${fromToken}`);
      const amountIn = ethers.utils.parseUnits(amount.toString(), decimalsIn);

      const currentAllowance = await retryRpcOperation(async () => tokenInContract.allowance(this.wallet.address, CONTRACT_ADDRESSES.swapRouter), `Get Allowance for ${fromToken}`);
      
      if (currentAllowance.lt(amountIn)) {
        this.logger.info(`Approval needed for ${fromToken}.`);
        await sendTransactionWithNonceHandling(
            this.wallet, `Approve ${fromToken} for SwapRouter`,
            async (nonce, feeData, defaultGasLimit) => {
                let txOverrides = { nonce, ...feeData };
                try {
                    // Estimate gas inside txBuilderFn to use current nonce
                    const estGas = await tokenInContract.estimateGas.approve(CONTRACT_ADDRESSES.swapRouter, ethers.constants.MaxUint256, txOverrides);
                    txOverrides.gasLimit = estGas.mul(130).div(100);
                } catch (e) { this.logger.warn(`Gas est for ${fromToken} approve failed, using default ${defaultGasLimit}. Err: ${e.message}`); txOverrides.gasLimit = defaultGasLimit;}
                return tokenInContract.approve(CONTRACT_ADDRESSES.swapRouter, ethers.constants.MaxUint256, txOverrides);
            }, ethers.BigNumber.from(100000)
        );
        this.logger.info(`${fromToken} approval successful.`);
      } else { this.logger.info(`${fromToken} allowance sufficient.`); }

      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
      const exactInputSingleParams = [tokenInAddress, tokenOutAddress, FEE_TIERS.LOW, this.wallet.address, amountIn, 0, 0];
      const exactInputSingleData = new ethers.utils.Interface(["function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) external payable returns (uint256 amountOut)"]).encodeFunctionData("exactInputSingle", [exactInputSingleParams]);
      const multicallInterface = new ethers.utils.Interface(["function multicall(uint256 deadline, bytes[] calldata data) external payable returns (bytes[] memory results)"]);
      const txData = multicallInterface.encodeFunctionData("multicall", [deadline, [exactInputSingleData]]);
      
      const txHash = await sendTransactionWithNonceHandling(
          this.wallet, `Swap ${fromToken} to ${toToken}`,
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

    } catch (error) {
      this.logger.error(`Swap operation failed definitively for ${fromToken} to ${toToken}: ${error.message}`);
      return null;
    }
  }
}

async function checkBalances(wallet) { 
  try {
    logger.info(`Checking balances for wallet: ${wallet.address}`);
    const phrsContract = new ethers.Contract(TOKEN_ADDRESSES.PHRS, ERC20_ABI, provider);
    const usdcContract = new ethers.Contract(TOKEN_ADDRESSES.USDC, ERC20_ABI, provider);
    const phrsNativeBalance = await retryRpcOperation(async () => provider.getBalance(wallet.address), `Get Native Balance for ${wallet.address}`);
    const phrsTokenBalance = await retryRpcOperation(async () => phrsContract.balanceOf(wallet.address), `Get PHRS Balance for ${wallet.address}`);
    const usdcBalance = await retryRpcOperation(async () => usdcContract.balanceOf(wallet.address), `Get USDC Balance for ${wallet.address}`);
    const phrsDecimals = await retryRpcOperation(async () => phrsContract.decimals(), `Get PHRS Decimals`);
    const usdcDecimals = await retryRpcOperation(async () => usdcContract.decimals(), `Get USDC Decimals`);
    logger.info(`Native PHRS (gas): ${ethers.utils.formatUnits(phrsNativeBalance, 18)} PHRS`);
    logger.info(`WPHRS Token (using PHRS key): ${ethers.utils.formatUnits(phrsTokenBalance, phrsDecimals)} WPHRS`);
    logger.info(`USDC Token: ${ethers.utils.formatUnits(usdcBalance, usdcDecimals)} USDC`);
    return { phrsNativeBalance, phrsTokenBalance, usdcBalance, phrsDecimals, usdcDecimals };
  } catch (error) { logger.error(`Balance check failed for ${wallet.address} after retries: ${error.message}`); return { phrsNativeBalance: ethers.BigNumber.from(0), phrsTokenBalance: ethers.BigNumber.from(0), usdcBalance: ethers.BigNumber.from(0), phrsDecimals: 18, usdcDecimals: 6 };}
}
async function getPoolAddress(tokenA, tokenB, fee) { 
  const factoryContract = new ethers.Contract(CONTRACT_ADDRESSES.factory, FACTORY_ABI, provider);
  return await retryRpcOperation( async () => { const poolAddress = await factoryContract.getPool(tokenA, tokenB, fee); logger.info(`Pool address for ${tokenA}-${tokenB} (Fee: ${fee}): ${poolAddress}`); return poolAddress === ethers.constants.AddressZero ? null : poolAddress; }, `Get Pool Address for ${tokenA}-${tokenB}`);
}
async function findExistingPosition(wallet, token0, token1, fee) { 
  const positionManager = new ethers.Contract(CONTRACT_ADDRESSES.positionManager, POSITION_MANAGER_ABI, wallet);
  try {
    const balance = await retryRpcOperation(async () => positionManager.balanceOf(wallet.address), `Get Position Manager Balance for ${wallet.address}`);
    if (balance.eq(0)) { logger.info(`No existing NFT positions for ${wallet.address}.`); return null; }
    const inputToken0 = token0.toLowerCase(); const inputToken1 = token1.toLowerCase();
    logger.info(`Found ${balance.toString()} NFT positions for ${wallet.address}. Checking...`);
    for (let i = 0; i < balance.toNumber(); i++) {
      let tokenId;
      try {
        tokenId = await retryRpcOperation(async () => positionManager.tokenOfOwnerByIndex(wallet.address, i), `Get Token ID at Index ${i} for ${wallet.address}`);
        const position = await retryRpcOperation(async () => positionManager.positions(tokenId), `Get Position Details for Token ID ${tokenId}`);
        const positionToken0 = position.token0.toLowerCase(); const positionToken1 = position.token1.toLowerCase();
        if ( ((positionToken0 === inputToken0 && positionToken1 === inputToken1) || (positionToken0 === inputToken1 && positionToken1 === inputToken0)) && position.fee === fee ) {
          logger.info(`Found existing position #${tokenId} for WPHRS-USDC pair with fee ${fee}.`);
          return { tokenId, token0: position.token0, token1: position.token1, tickLower: position.tickLower, tickUpper: position.tickUpper };
        }
      } catch (err) { logger.warn(`Error checking position index ${i} (TokenID: ${tokenId || 'unknown'}) after retries: ${err.message}`); continue; }
    }
    logger.info(`No existing position found for specific WPHRS-USDC pair and fee ${fee}.`); return null;
  } catch (error) { logger.error(`Error finding existing positions after retries: ${error.message}`); return null; }
}

function prompt(question) { return new Promise(resolve => readline.question(question, resolve));}

async function retry(fn, maxAttempts = 2, delay = 10000, operationName = "Unnamed operation") {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try { return await fn(); }
    catch (error) {
      logger.warn(`Operation "${operationName}" attempt ${attempt}/${maxAttempts} failed: ${error.message}`);
      if (attempt === maxAttempts) { logger.error(`Operation "${operationName}" ultimately failed after ${maxAttempts} attempts.`); throw error; }
      if (isNonceRelatedError(error)) { logger.warn(`Nonce-related error during general retry for "${operationName}".`);}
      await new Promise(resolve => setTimeout(resolve, delay + (attempt * 3000) ));
    }
  }
}

async function main() { 
    try { provider = await initializeGlobalProvider(); } 
    catch (error) { logger.error(`Failed to initialize provider. Exiting. Error: ${error.message}`); process.exit(1); }

    console.log(CSSURABAYA_ASCII); console.log("Welcome!"); console.log(`Join: ${TELEGRAM_CHANNEL}`);
    logger.info('JWT Token removed. Verification may be impacted.');
    logger.info(`Script will retry RPC operations indefinitely if RPC issues are detected.`);

    const privateKeysInput = await prompt('Enter PKs (comma-separated): ');
    const privateKeys = privateKeysInput.split(',').map(k=>k.trim()).map(k=>k.startsWith('0x')?k:'0x'+k).filter(k=>ethers.utils.isHexString(k,32));
    const wallets = [];
    for (const key of privateKeys) {
        try { wallets.push(new ethers.Wallet(key, provider)); logger.info(`Wallet added: ${wallets[wallets.length-1].address}`);}
        catch (error) { logger.error(`Invalid PK: ${key.slice(0,10)}... ${error.message}`); }
    }
    if (wallets.length === 0) { logger.error('No valid wallets. Exiting.'); readline.close(); return; }

    console.log('\nMenu:\n1. Swap WPHRS->USDC\n2. Swap USDC->WPHRS\n3. Add/Increase Liquidity\n5. Check Balances');
    const option = await prompt('Select (1,2,3,5): ');
    if (!['1','2','3','5'].includes(option)) { logger.error('Invalid option.'); readline.close(); return; }

    let loopCount = 1;
    if (['1','2','3'].includes(option)) {
        const loopInput = await prompt('Loops (e.g.,1): '); loopCount = parseInt(loopInput);
        if (isNaN(loopCount)||loopCount<1) { logger.warn('Invalid loops, defaulting to 1.'); loopCount=1;}
    }
    const delayBetweenLoopsMs = 5000;

    try {
        for (const wallet of wallets) {
            logger.info(`\n--- Wallet: ${wallet.address} ---`);
            let balances = await checkBalances(wallet);
            const swapService = new SwapService(wallet, logger);

            if (option === '1' || option === '2') {
                const from = option==='1'?'PHRS':'USDC'; const to = option==='1'?'USDC':'PHRS';
                const promptName = option==='1'?'WPHRS(PHRS key)':'USDC';
                const amtIn = await prompt(`Amount of ${promptName} to swap: `); const amount = parseFloat(amtIn);
                if (isNaN(amount)||amount<=0) { logger.error('Invalid amount.'); continue; }

                for (let i=0; i<loopCount; i++) {
                    logger.info(`Loop ${i+1}/${loopCount} for ${from}->${to} swap`);
                    try {
                        balances = await checkBalances(wallet);
                        const balChk=(from==='PHRS')?balances.phrsTokenBalance:balances.usdcBalance;
                        const decChk=(from==='PHRS')?balances.phrsDecimals:balances.usdcDecimals;
                        if(balChk.lt(ethers.utils.parseUnits(amount.toString(),decChk))) { logger.error(`Insuff ${from}. Have: ${ethers.utils.formatUnits(balChk,decChk)}. Need: ${amount}. Skip loop iter.`); continue;}
                        if(balances.phrsNativeBalance.lt(ethers.utils.parseUnits('0.005',18))) { logger.error(`Insuff native PHRS for gas. Skip loop iter.`); continue;}
                        await retry(() => swapService.swap(from,to,amount), 2, 10000, `${from}->${to} Swap Operation`);
                    } catch (opError) { logger.error(`Swap operation loop ${i+1} failed for wallet ${wallet.address}: ${opError.message}`); }
                    if (loopCount>1 && i<loopCount-1) await new Promise(r=>setTimeout(r,delayBetweenLoopsMs));
                }
            } else if (option === '3') {
                 for (let i=0; i<loopCount; i++) {
                    logger.info(`Loop ${i+1}/${loopCount} for Add/Increase Liquidity`);
                    try {
                        balances = await checkBalances(wallet);
                        if(balances.phrsNativeBalance.lt(ethers.utils.parseUnits('0.01',18))) { logger.error('Insuff native PHRS for gas. Skip loop iter.'); continue;}
                        await retry(() => autoAddLiquidity(wallet, balances), 1, 10000, `Add/Increase Liquidity Operation`);
                    } catch (opError) { logger.error(`Add/Increase Liquidity operation loop ${i+1} failed for wallet ${wallet.address}: ${opError.message}`);}
                    if (loopCount>1 && i<loopCount-1) await new Promise(r=>setTimeout(r,delayBetweenLoopsMs));
                }
            } else if (option === '5') { if (!balances) await checkBalances(wallet); }
        }
    } catch (error) { logger.error(`Main loop error: ${error.message}\n${error.stack}`); }
    readline.close();
}

async function autoAddLiquidity(wallet, currentBalances) {
  logger.info(`\nAttempting Liq for WPHRS-USDC (0.05% fee) for ${wallet.address}...`);
  const positionManager=new ethers.Contract(CONTRACT_ADDRESSES.positionManager,POSITION_MANAGER_ABI,wallet);
  const phrsContract=new ethers.Contract(TOKEN_ADDRESSES.PHRS,ERC20_ABI,wallet);
  const usdcContract=new ethers.Contract(TOKEN_ADDRESSES.USDC,ERC20_ABI,wallet);
  const swapService = new SwapService(wallet, logger); 

  const targetPhrsToAdd = 0.001; const feeTier = FEE_TIERS.LOW;
  const tickLower = Math.ceil(-887272/10)*10; const tickUpper = Math.floor(887272/10)*10;
  logger.info(`Using tick range: [${tickLower}, ${tickUpper}]`);

  const {phrsTokenBalance,usdcBalance,phrsDecimals,usdcDecimals} = currentBalances;
  let amountPhrsDesired = ethers.utils.parseUnits(targetPhrsToAdd.toString(),phrsDecimals);
  let amountUsdcDesired;

  if(phrsTokenBalance.lt(amountPhrsDesired)){logger.error(`Insuff WPHRS. Need ${targetPhrsToAdd}. Skip.`);return;}

  let token0Addr=TOKEN_ADDRESSES.PHRS; let token1Addr=TOKEN_ADDRESSES.USDC; let isPhrsT0=true;
  if(ethers.BigNumber.from(token0Addr).gt(ethers.BigNumber.from(token1Addr))){
    [token0Addr,token1Addr]=[token1Addr,token0Addr]; isPhrsT0=false;
    logger.info(`Pool order: token0=USDC, token1=WPHRS`);
  } else { logger.info(`Pool order: token0=WPHRS, token1=USDC`);}

  const poolAddr = await getPoolAddress(TOKEN_ADDRESSES.PHRS,TOKEN_ADDRESSES.USDC,feeTier);
  let smallDefUsdc = 0.001;

  if(poolAddr){
    const poolContract = new ethers.Contract(poolAddr,['function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'],provider);
    try {
      const slot0 = await retryRpcOperation(async()=>poolContract.slot0(),`Get Slot0 Pool ${poolAddr}`);
      if(!slot0.sqrtPriceX96.isZero()){ amountUsdcDesired = ethers.utils.parseUnits(smallDefUsdc.toString(),usdcDecimals); logger.warn(`Pool exists, using default USDC ${smallDefUsdc} for simplicity.`);}
      else { amountUsdcDesired = ethers.utils.parseUnits(smallDefUsdc.toString(),usdcDecimals); logger.info(`Pool exists (sqrtPriceX96 0). Default USDC: ${smallDefUsdc}`);}
    } catch(e){logger.warn(`Could not read slot0 (retries done): ${e.message}. Default USDC: ${smallDefUsdc}`); amountUsdcDesired = ethers.utils.parseUnits(smallDefUsdc.toString(),usdcDecimals);}
  } else {logger.info('No WPHRS-USDC pool. Creating with default USDC pair.'); amountUsdcDesired = ethers.utils.parseUnits(smallDefUsdc.toString(),usdcDecimals);}

  if(usdcBalance.lt(amountUsdcDesired)){logger.error(`Insuff USDC. Need ${ethers.utils.formatUnits(amountUsdcDesired,usdcDecimals)}. Skip.`); return;}
  
  const phrsAllowance = await retryRpcOperation(async()=>phrsContract.allowance(wallet.address,CONTRACT_ADDRESSES.positionManager),`Get PHRS Allow`);
  if(phrsAllowance.lt(amountPhrsDesired)){
    await sendTransactionWithNonceHandling( wallet, `Approve PHRS for PositionManager`,
        async (nonce, feeData, defaultGasLimit) => {
            let txOverrides = { nonce, ...feeData };
            try {
                const estGas = await phrsContract.estimateGas.approve(CONTRACT_ADDRESSES.positionManager, ethers.constants.MaxUint256, txOverrides);
                txOverrides.gasLimit = estGas.mul(130).div(100);
            } catch (e) { logger.warn(`Gas est for PHRS approve failed, using default ${defaultGasLimit}. Err: ${e.message}`); txOverrides.gasLimit = defaultGasLimit;}
            return phrsContract.approve(CONTRACT_ADDRESSES.positionManager,ethers.constants.MaxUint256,txOverrides);
        }, ethers.BigNumber.from(120000)
    );
    logger.info('PHRS approval successful.');
  } else {logger.info('PHRS approval sufficient.');}

  const usdcAllowance = await retryRpcOperation(async()=>usdcContract.allowance(wallet.address,CONTRACT_ADDRESSES.positionManager),`Get USDC Allow`);
  if(usdcAllowance.lt(amountUsdcDesired)){
    await sendTransactionWithNonceHandling( wallet, `Approve USDC for PositionManager`,
        async (nonce, feeData, defaultGasLimit) => {
            let txOverrides = { nonce, ...feeData };
            try {
                const estGas = await usdcContract.estimateGas.approve(CONTRACT_ADDRESSES.positionManager, ethers.constants.MaxUint256, txOverrides);
                txOverrides.gasLimit = estGas.mul(130).div(100);
            } catch (e) { logger.warn(`Gas est for USDC approve failed, using default ${defaultGasLimit}. Err: ${e.message}`); txOverrides.gasLimit = defaultGasLimit;}
            return usdcContract.approve(CONTRACT_ADDRESSES.positionManager,ethers.constants.MaxUint256,txOverrides);
        }, ethers.BigNumber.from(120000)
    );
    logger.info('USDC approval successful.');
  } else {logger.info('USDC approval sufficient.');}

  const finalAmt0Des = isPhrsT0?amountPhrsDesired:amountUsdcDesired;
  const finalAmt1Des = isPhrsT0?amountUsdcDesired:amountPhrsDesired;
  const descAmt0 = ethers.utils.formatUnits(finalAmt0Des,isPhrsT0?phrsDecimals:usdcDecimals);
  const descAmt1 = ethers.utils.formatUnits(finalAmt1Des,isPhrsT0?usdcDecimals:phrsDecimals);
  const sym0 = isPhrsT0?"WPHRS":"USDC"; const sym1 = isPhrsT0?"USDC":"WPHRS";

  const existPos = await findExistingPosition(wallet,TOKEN_ADDRESSES.PHRS,TOKEN_ADDRESSES.USDC,feeTier);
  let txHash;

  if(existPos && existPos.tickLower===tickLower && existPos.tickUpper===tickUpper){
    logger.info(`Increasing liq for pos #${existPos.tokenId}.`);
    const params = {tokenId:existPos.tokenId,amount0Desired:finalAmt0Des,amount1Desired:finalAmt1Des,amount0Min:0,amount1Min:0,deadline:Math.floor(Date.now()/1000)+1200};
    logger.info(`Increasing with: ${descAmt0} ${sym0}, ${descAmt1} ${sym1}`);
    txHash = await sendTransactionWithNonceHandling( wallet, `Increase Liquidity`,
        async (nonce, feeData, defaultGasLimit) => {
            let txOverrides = { nonce, ...feeData };
            try {
                 const estGas = await positionManager.estimateGas.increaseLiquidity(params, txOverrides);
                 txOverrides.gasLimit = estGas.mul(130).div(100);
            } catch(e) {logger.warn(`Gas est for Increase Liq failed. Using default ${defaultGasLimit}. Err: ${e.message}`); txOverrides.gasLimit = defaultGasLimit;}
            return positionManager.increaseLiquidity(params,txOverrides); // Corrected this line
        }, ethers.BigNumber.from(700000)
    );
  } else {
    if(existPos) logger.info(`Existing pos #${existPos.tokenId} has diff ticks. Minting new.`);
    else logger.info('Minting new liq pos...');
    const mintParams = {token0:token0Addr,token1:token1Addr,fee:feeTier,tickLower,tickUpper,amount0Desired:finalAmt0Des,amount1Desired:finalAmt1Des,amount0Min:0,amount1Min:0,recipient:wallet.address,deadline:Math.floor(Date.now()/1000)+1200};
    logger.info(`Minting with: ${descAmt0} ${sym0}, ${descAmt1} ${sym1}`);
    txHash = await sendTransactionWithNonceHandling( wallet, `Mint Liquidity`,
        async (nonce, feeData, defaultGasLimit) => {
            let txOverrides = { nonce, ...feeData };
             try {
                 const estGas = await positionManager.estimateGas.mint(mintParams, txOverrides);
                 txOverrides.gasLimit = estGas.mul(130).div(100);
            } catch(e) {logger.warn(`Gas est for Mint Liq failed. Using default ${defaultGasLimit}. Err: ${e.message}`); txOverrides.gasLimit = defaultGasLimit;}
            return positionManager.mint(mintParams,txOverrides); // Corrected this line
        }, ethers.BigNumber.from(1000000)
    );
  }
  logger.info(`Liquidity op successful: https://testnet.pharosscan.xyz/tx/${txHash}`);
}

(async () => {
    try { await main(); } 
    catch (error) { logger.error(`Unhandled script error: ${error.message}\n${error.stack}`); process.exit(1); }
})();
