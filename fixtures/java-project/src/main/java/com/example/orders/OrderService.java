package com.example.orders;

public class OrderService {
    public String find(String id) {
        if (id.startsWith("missing-")) {
            throw new IllegalStateException("order not found");
        }
        return "order-" + id;
    }

    public String submit(OrderRequest request) {
        switch (request.priority()) {
            case "high":
                return "queued-high";
            default:
                return "queued-standard";
        }
    }
}
