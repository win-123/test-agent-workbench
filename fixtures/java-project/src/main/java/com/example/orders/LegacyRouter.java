package com.example.orders;

public class LegacyRouter {
    public Object route(String className) throws Exception {
        Class<?> type = Class.forName(className);
        return type.getMethod("handle").invoke(type.getDeclaredConstructor().newInstance());
    }
}
