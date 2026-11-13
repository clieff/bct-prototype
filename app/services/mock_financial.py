from dataclasses import dataclass
import secrets
from threading import Lock
from typing import Dict, Optional

@dataclass
class TransactionResponse:
    status: str
    amount: int
    fee: int
    beneficiary: str
    reference: str
    error: Optional[str] = None
    balance_after: Optional[int] = None

_ACCOUNTS: Dict[str, int] = {"default": 50000}
_ACCOUNT_LOCK = Lock()


def _format_fcfa(amount: int) -> str:
    return f"{amount:,}".replace(",", " ")


def calculate_fee(amount: int) -> int:
    """Applique le barème commun utilisé par /fees et /transfer."""
    if type(amount) is not int or amount <= 0:
        raise ValueError("Le montant doit être un entier positif.")
    return 100 if amount <= 5000 else 200


def transfer(sender: str, beneficiary: str, amount: int) -> TransactionResponse:
    fee = calculate_fee(amount)
    total = amount + fee
    with _ACCOUNT_LOCK:
        balance = _ACCOUNTS.get(sender, 0)
        if balance < total:
            error = (
                f"Solde insuffisant. Solde disponible : {_format_fcfa(balance)} FCFA ; "
                f"montant et frais requis : {_format_fcfa(amount)} + "
                f"{_format_fcfa(fee)} = {_format_fcfa(total)} FCFA."
            )
            return TransactionResponse(
                "failure",
                amount,
                fee,
                beneficiary,
                f"TXN-{secrets.token_hex(6).upper()}",
                error,
                balance,
            )

        _ACCOUNTS[sender] = balance - total
        balance_after = _ACCOUNTS[sender]

    return TransactionResponse(
        "success",
        amount,
        fee,
        beneficiary,
        f"TXN-{secrets.token_hex(6).upper()}",
        balance_after=balance_after,
    )

def get_balance(sender: str) -> int:
    with _ACCOUNT_LOCK:
        return _ACCOUNTS.get(sender, 0)
