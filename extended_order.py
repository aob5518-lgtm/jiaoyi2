import sys
import json
import asyncio
from decimal import Decimal

from x10.config import MAINNET_CONFIG
from x10.core.stark_account import StarkPerpetualAccount
from x10.models.order import OrderSide, TimeInForce, OrderType
from x10.perpetual.simple_client.simple_trading_client import BlockingTradingClient


def to_decimal(value, digits=None):
    n = Decimal(str(value))
    if digits is not None:
        quant = Decimal("1").scaleb(-digits)
        n = n.quantize(quant)
    return n


async def main():
    raw = sys.stdin.read()

    if not raw:
        print(json.dumps({
            "ok": False,
            "error": "Extended helper 未收到输入参数"
        }, ensure_ascii=False))
        sys.exit(1)

    client = None

    try:
        data = json.loads(raw)

        api_key = str(data["apiKey"])
        public_key = str(data["publicKey"])
        private_key = str(data["starkPrivateKey"])
        vault = data["vault"]
        market = str(data["market"])

        # 保持你原来脚本的价格 / 数量精度逻辑
        price = to_decimal(round(float(data["price"]), 1), 1)
        size = to_decimal(round(float(data["size"]), 3), 3)

        side_text = str(data["side"]).lower()
        side = OrderSide.BUY if side_text == "buy" else OrderSide.SELL
        reduce_only = bool(data.get("reduceOnly", False))

        if price <= 0:
            raise ValueError(f"下单价格无效: {price}")

        if size <= 0:
            raise ValueError(f"下单数量无效: {size}")

        account = StarkPerpetualAccount(
            vault=vault,
            private_key=private_key,
            public_key=public_key,
            api_key=api_key
        )

        client = await BlockingTradingClient.create(
            MAINNET_CONFIG,
            account
        )

        placed_order = await client.create_and_place_order(
            market_name=market,
            amount_of_synthetic=size,
            price=price,
            side=side,
            taker_fee=Decimal("0.0005"),
            time_in_force=TimeInForce.IOC,
            reduce_only=reduce_only,
            order_type=OrderType.LIMIT
        )

        print(json.dumps({
            "ok": True,
            "id": getattr(placed_order, "id", None),
            "externalId": getattr(placed_order, "external_id", None),
            "market": market,
            "price": str(price),
            "size": str(size),
            "side": "buy" if side == OrderSide.BUY else "sell",
            "reduceOnly": reduce_only,
            "status": str(getattr(placed_order, "status", "")),
            "filledQty": str(getattr(placed_order, "filled_qty", "") or "")
        }, ensure_ascii=False))

    except Exception as e:
        print(json.dumps({
            "ok": False,
            "error": str(e)
        }, ensure_ascii=False))
        sys.exit(1)

    finally:
        try:
            if client is not None and hasattr(client, "close"):
                result = client.close()
                if asyncio.iscoroutine(result):
                    await result
        except Exception:
            pass


if __name__ == "__main__":
    asyncio.run(main())
