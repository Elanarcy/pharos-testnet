# pharos-testnet
tools auto swap add liquidity


# Pharos Testnet Interaction Script (by CSSurabaya)

[![CSSurabaya ASCII Art](https://img.shields.io/badge/Project_By-CSSURABAYA-blueviolet)](t.me/cssurabaya)

Welcome to the Pharos Testnet Interaction Script! This Node.js tool is designed to help users interact with the Pharos Testnet, specifically for performing token swaps and managing liquidity on a decentralized exchange. It features an interactive command-line interface, robust transaction handling with RPC retries, nonce management, and task verification.

**Join our Telegram Channel: [t.me/cssurabaya](t.me/cssurabaya)**

## Features

* **Token Swaps:**
    * Swap WPHRS (wrapped PHRS) to USDC.
    * Swap USDC to WPHRS.
* **Liquidity Management:**
    * Add new liquidity for the WPHRS/USDC pair.
    * Increase liquidity for existing WPHRS/USDC positions.
* **Balance Checking:**
    * View your Native PHRS (for gas), WPHRS token, and USDC token balances.
* **Interactive CLI:**
    * User-friendly prompts for entering private keys, selecting operations, and specifying amounts/loops.
* **Robust Transaction Handling:**
    * Automatic retries for RPC errors with configurable delays.
    * Nonce management to handle common transaction submission issues.
    * Gas estimation with fallbacks and multipliers.
* **Task Verification:**
    * Attempts to verify tasks with the Pharos API after successful transactions.
* **Logging:**
    * Logs important actions, warnings, and errors to the console.
    * Records details of failed task verifications to `failed_verifications.txt` for manual follow-up.

## Prerequisites

Before you begin, ensure you have the following installed:

* **Node.js:** (Recommended: v14.x or later)
* **npm** (Node Package Manager) or **yarn**

## Installation

1.  **Clone the repository (or download the script):**
    ```bash
    git clone https://github.com/Elanarcy/pharos-testnet.git
    ```

2.  **Install dependencies:**
    Open your terminal in the project directory and run:
    ```bash
    npm install ethers axios
    ```
    or, if you prefer yarn:
    ```bash
    yarn add ethers axios
    ```

## Configuration

While most settings are hardcoded for the Pharos Testnet, be aware of the following:

* **Private Keys:** The script will **prompt you to enter your private key(s)** when you run it.
    * **IMPORTANT:** Never hardcode your private keys directly into the script if you plan to share it or commit it to a public repository. Handle your private keys with extreme care.
* **RPC Endpoint:** The script is configured to use a specific RPC URL for the Pharos Testnet (`https://api.zan.top/node/v1/pharos/testnet/...`). If this endpoint becomes unavailable or you wish to use a different one, you can modify it in the `RPC_URLS` array within the script.
    ```javascript
    const RPC_URLS = [
        '[https://api.zan.top/node/v1/pharos/testnet/1761472bf26745488907477d23719fb5](https://api.zan.top/node/v1/pharos/testnet/1761472bf26745488907477d23719fb5)' // Zan RPC
    ];
    ```
* **Network and Contract Addresses:** The `CHAIN_ID`, `PHAROS_API_URL`, `TOKEN_ADDRESSES`, and `CONTRACT_ADDRESSES` are predefined for the Pharos Testnet environment targeted by this script. These typically do not need to be changed unless the testnet environment or the DEX contracts are updated.

## Usage

1.  **Navigate to the script's directory** in your terminal.
2.  **Run the script** using Node.js:
    ```bash
    node main.js
    ```


3.  **Follow the on-screen prompts:**
    * You will be asked to **enter your wallet private key(s)** (comma-separated if multiple).
    * A **menu** will appear with available actions:
        1.  Swap WPHRS->USDC
        2.  Swap USDC->WPHRS
        3.  Add/Increase Liquidity
        5.  Check Balances
    * Based on your selection, you might be asked for the **number of loops** (for swaps/liquidity actions) and the **amount of tokens** to use.

## Important Notes

* **Failed Verifications Log:** If the script fails to verify a task via the Pharos API, it will append the relevant details (wallet address, task ID, transaction hash, explorer link, and manual verification steps) to a file named `failed_verifications.txt` in the same directory as the script.
* **RPC and Nonce Handling:** The script includes logic to automatically retry operations if it detects RPC errors or nonce-related issues. This is designed to improve the reliability of transactions on potentially congested or unstable testnet environments.
* **Gas Management:** The script attempts to estimate gas for transactions and applies a multiplier. It also includes default gas limits as fallbacks. For EIP-1559 transactions, it aims to increase `maxFeePerGas` and `maxPriorityFeePerGas` slightly.

## ⚠️ Disclaimer

* This script is intended for use on the **Pharos Testnet** and interacts with smart contracts deployed there.
* **YOU ARE SOLELY RESPONSIBLE FOR THE SECURITY OF YOUR PRIVATE KEYS.** Never share them with anyone. 
* Use this script at your own risk. The authors or contributors are not responsible for any loss of funds (even testnet funds) or any other issues that may arise from its use.
* Always review the code and understand what it does before running it with your valuable assets or sensitive information.

## Contributing

Contributions, issues, and feature requests are welcome! Please feel free to open an issue or submit a pull request if you have improvements.

---

*This README was generated based on the script provided.*
*Last Updated: May 2025*
